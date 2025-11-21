import os
import logging
import random
from dataclasses import dataclass
from typing import Dict, List, Set, Optional
from datetime import datetime

import httpx
from telegram import Update
from telegram.ext import (
    ApplicationBuilder,
    CommandHandler,
    ContextTypes,
)

# ======================================================
# Logging
# ======================================================

logging.basicConfig(
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    level=logging.INFO,
)
logger = logging.getLogger(__name__)

# ======================================================
# Environment / Webhook config
# ======================================================

BOT_TOKEN = os.environ["BOT_TOKEN"]  # Telegram bot token (on Render)
PORT = int(os.environ.get("PORT", "10000"))

BASE_URL = os.environ.get("RENDER_EXTERNAL_URL", "").rstrip("/")
if not BASE_URL:
    raise RuntimeError(
        "RENDER_EXTERNAL_URL is not set. On Render it is injected automatically "
        "for Web Services. Make sure you're deploying as a Web Service."
    )

WEBHOOK_PATH = BOT_TOKEN          # use token as URL path
WEBHOOK_URL = f"{BASE_URL}/{WEBHOOK_PATH}"

# Provider API keys (set these in Render → Environment)
TICKETMASTER_API_KEY = os.environ.get("TICKETMASTER_API_KEY")  # Ticketmaster Discovery
SKIDDLE_API_KEY = os.environ.get("SKIDDLE_API_KEY")            # Skiddle API

# ======================================================
# In-memory “DB”
# ======================================================

USER_ARTISTS: Dict[int, List[str]] = {}
USER_CITIES: Dict[int, List[str]] = {}
KNOWN_USERS: Set[int] = set()

UK_DEFAULT_CITIES = [
    "London",
    "Manchester",
    "Leeds",
    "Birmingham",
    "Liverpool",
    "Glasgow",
    "Edinburgh",
    "Bristol",
]


# ======================================================
# Models & helpers
# ======================================================

@dataclass
class Opportunity:
    name: str
    city: str
    source: str       # e.g. "Ticketmaster UK"
    primary_price: float
    resale_price: float
    demand_score: float   # 0–100
    risk_score: float     # 0–100
    url: Optional[str] = None

    @property
    def margin_pct(self) -> float:
        if self.primary_price <= 0:
            return 0.0
        return max(
            0.0,
            (self.resale_price - self.primary_price) / self.primary_price * 100.0,
        )

    @property
    def trade_score(self) -> float:
        # First version: demand + margin – risk
        return self.demand_score + self.margin_pct - self.risk_score


def add_to_list(store: Dict[int, List[str]], user_id: int, value: str) -> None:
    """Add string to user list, avoiding duplicates (case-insensitive)."""
    value = value.strip()
    if not value:
        return
    current = store.get(user_id, [])
    lower_values = [v.lower() for v in current]
    if value.lower() not in lower_values:
        current.append(value)
        store[user_id] = current


def format_watchlist(user_id: int) -> str:
    artists = USER_ARTISTS.get(user_id, [])
    cities = USER_CITIES.get(user_id, [])
    if not artists and not cities:
        return (
            "You’re not watching anything yet.\n\n"
            "Use:\n"
            "• /addartist Central Cee\n"
            "• /addcity Manchester\n"
            "to teach me what to scan in the UK market."
        )

    lines = ["🎧 *Your current UK watchlist:*"]
    if artists:
        lines.append("• *Artists:* " + ", ".join(artists))
    if cities:
        lines.append("• *Cities:* " + ", ".join(cities))
    return "\n".join(lines)


def matches_user(opp: Opportunity, artists: List[str], cities: List[str]) -> bool:
    """Check if an opportunity matches a user’s artist/city interests."""
    name_lower = opp.name.lower()
    city_lower = opp.city.lower()

    artist_ok = (
        not artists
        or any(a.lower() in name_lower for a in artists)
    )
    city_ok = (
        not cities
        or any(c.lower() in city_lower for c in cities)
    )
    return artist_ok and city_ok


# ======================================================
# Providers: Ticketmaster UK & Skiddle UK
# ======================================================

async def fetch_ticketmaster_uk(
    artists: List[str],
    cities: List[str],
    max_events: int = 40,
) -> List[Opportunity]:
    """
    Fetch events from Ticketmaster UK Discovery API.
    Requires TICKETMASTER_API_KEY.
    """
    if not TICKETMASTER_API_KEY:
        logger.debug("No TICKETMASTER_API_KEY; skipping Ticketmaster provider.")
        return []

    params = {
        "apikey": TICKETMASTER_API_KEY,
        "countryCode": "GB",
        "size": max_events,
        "sort": "date,asc",
    }
    if artists:
        params["keyword"] = " ".join(artists)

    url = "https://app.ticketmaster.com/discovery/v2/events.json"

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(url, params=params)
            resp.raise_for_status()
            data = resp.json()
    except Exception as e:
        logger.warning("Ticketmaster UK fetch failed: %s", e)
        return []

    events: List[Opportunity] = []
    embedded = data.get("_embedded", {})
    for ev in embedded.get("events", []):
        name = ev.get("name", "Unknown TM Event")

        # City
        city = "Unknown"
        try:
            city = ev["_embedded"]["venues"][0]["city"]["name"]
        except Exception:
            pass

        # Start date (for scoring, optional)
        start_date_str = ev.get("dates", {}).get("start", {}).get("dateTime")

        # Price estimate
        primary_price = 0.0
        price_ranges = ev.get("priceRanges") or []
        if price_ranges:
            pr = price_ranges[0]
            if "min" in pr:
                primary_price = float(pr["min"])
            elif "max" in pr:
                primary_price = float(pr["max"])

        # Demand heuristic
        demand_score = random.uniform(55, 90)

        # Slight boost if city matches user's cities list
        if cities and any(c.lower() == city.lower() for c in cities):
            demand_score += 5

        # Slight boost if event is soon-ish
        if start_date_str:
            try:
                dt = datetime.fromisoformat(start_date_str.replace("Z", "+00:00"))
                days = max(0.0, (dt - datetime.utcnow()).days)
                if days < 30:
                    demand_score += (30 - days) * 0.5
            except Exception:
                pass

        demand_score = min(demand_score, 100.0)

        # Risk heuristic – moderate for TM
        risk_score = random.uniform(10, 25)

        # Rough resale estimate
        if primary_price > 0:
            multiplier = 1.0 + (demand_score - 50) / 150.0  # between ~1.1 and 1.6
            resale_price = max(primary_price * multiplier, primary_price + 10.0)
        else:
            resale_price = 0.0

        url_ev = ev.get("url")

        events.append(
            Opportunity(
                name=name,
                city=city,
                source="Ticketmaster UK",
                primary_price=primary_price,
                resale_price=resale_price,
                demand_score=demand_score,
                risk_score=risk_score,
                url=url_ev,
            )
        )

    logger.info("Ticketmaster UK provider returned %d events", len(events))
    return events


async def fetch_skiddle_uk(
    artists: List[str],
    cities: List[str],
    max_events: int = 40,
) -> List[Opportunity]:
    """
    Fetch events from Skiddle API (UK).
    Requires SKIDDLE_API_KEY.
    """
    if not SKIDDLE_API_KEY:
        logger.debug("No SKIDDLE_API_KEY; skipping Skiddle provider.")
        return []

    base_url = "https://www.skiddle.com/api/v1/events/search/"
    params = {
        "api_key": SKIDDLE_API_KEY,
        "country": "UK",
        "limit": max_events,
        "order": "date",
    }
    if artists:
        params["keyword"] = " ".join(artists)

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(base_url, params=params)
            resp.raise_for_status()
            data = resp.json()
    except Exception as e:
        logger.warning("Skiddle UK fetch failed: %s", e)
        return []

    events: List[Opportunity] = []
    for ev in data.get("results", []):
        name = ev.get("eventname") or "Unknown Skiddle Event"
        city = ev.get("town") or ev.get("venue", "") or "Unknown"

        primary_price = 0.0
        try:
            primary_price = float(ev.get("minprice") or 0.0)
        except Exception:
            pass

        demand_score = random.uniform(50, 90)

        if cities and any(c.lower() == city.lower() for c in cities):
            demand_score += 5

        demand_score = min(demand_score, 100.0)

        risk_score = random.uniform(12, 30)

        if primary_price > 0:
            multiplier = 1.0 + (demand_score - 50) / 140.0
            resale_price = max(primary_price * multiplier, primary_price + 8.0)
        else:
            resale_price = 0.0

        url_ev = ev.get("link")

        events.append(
            Opportunity(
                name=name,
                city=city,
                source="Skiddle",
                primary_price=primary_price,
                resale_price=resale_price,
                demand_score=demand_score,
                risk_score=risk_score,
                url=url_ev,
            )
        )

    logger.info("Skiddle provider returned %d events", len(events))
    return events


# ======================================================
# Commands
# ======================================================

async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    KNOWN_USERS.add(user_id)

    text = (
        "✅ Bot is online via Render (webhook mode).\n\n"
        "I’m your *UK event market radar*.\n\n"
        "Phase 1:\n"
        "• Build your watchlist\n"
        "• Pull real UK events from Ticketmaster + Skiddle (when keys are set)\n"
        "• Score them on demand.\n\n"
        "*Commands:*\n"
        "• /addartist Central Cee\n"
        "• /addcity Manchester\n"
        "• /mywatch – show what you’re tracking\n"
        "• /hotdemo – demo 'hot' UK opportunities\n"
        "• /ukhot – live UK scan (Ticketmaster + Skiddle)\n"
        "• /ping – health check"
    )
    await update.message.reply_text(text, parse_mode="Markdown")


async def ping(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text("🏓 Pong – UK market radar is alive.")


async def addartist(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    KNOWN_USERS.add(user_id)

    if not context.args:
        await update.message.reply_text(
            "Usage: /addartist Artist Name\nExample: /addartist Central Cee"
        )
        return

    artist = " ".join(context.args)
    add_to_list(USER_ARTISTS, user_id, artist)
    await update.message.reply_text(
        f"🎤 Added artist to your UK watchlist: *{artist}*",
        parse_mode="Markdown",
    )


async def addcity(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    KNOWN_USERS.add(user_id)

    if not context.args:
        await update.message.reply_text(
            "Usage: /addcity City Name\nExample: /addcity Manchester"
        )
        return

    city = " ".join(context.args)
    add_to_list(USER_CITIES, user_id, city)
    await update.message.reply_text(
        f"🏙 Added city to your UK watchlist: *{city}*",
        parse_mode="Markdown",
    )


async def mywatch(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    KNOWN_USERS.add(user_id)

    text = format_watchlist(user_id)
    await update.message.reply_text(text, parse_mode="Markdown")


async def hotdemo(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """
    DEMO: show fake UK opportunities with scoring to see behaviour.
    """
    user_id = update.effective_user.id
    KNOWN_USERS.add(user_id)

    artists = USER_ARTISTS.get(user_id, []) or ["Central Cee", "WHP", "Mint Festival"]
    cities = USER_CITIES.get(user_id, []) or ["Manchester", "London", "Leeds"]

    fake_events: List[Opportunity] = []
    uk_sources = ["Ticketmaster UK", "Skiddle", "DemoSource"]

    for i in range(4):
        artist = random.choice(artists)
        city = random.choice(cities)
        source = random.choice(uk_sources)

        primary_price = random.choice([35.0, 45.0, 60.0, 80.0])
        resale_price = primary_price * random.choice([1.2, 1.4, 1.6, 1.8])

        demand_score = random.uniform(55, 95)
        risk_score = random.uniform(5, 30)

        fake_events.append(
            Opportunity(
                name=f"{artist} – UK Show #{i+1}",
                city=city,
                source=source,
                primary_price=primary_price,
                resale_price=resale_price,
                demand_score=demand_score,
                risk_score=risk_score,
            )
        )

    fake_events.sort(key=lambda e: e.trade_score, reverse=True)

    lines = ["🔥 *Demo hot UK opportunities* _(fake data)_"]
    for ev in fake_events:
        lines.append(
            f"\n• *{ev.name}* ({ev.source}) – {ev.city}\n"
            f"  Primary: £{ev.primary_price:.2f} | Resale: ~£{ev.resale_price:.2f}\n"
            f"  Demand: {ev.demand_score:.1f} | Margin: {ev.margin_pct:.1f}% | "
            f"Risk: {ev.risk_score:.1f}\n"
            f"  → Trade score: *{ev.trade_score:.1f}*"
        )

    await update.message.reply_text("\n".join(lines), parse_mode="Markdown")


async def ukhot(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """
    Live UK scan: pulls from Ticketmaster + Skiddle (if keys set),
    then shows top events matching this user's interests.
    """
    user_id = update.effective_user.id
    KNOWN_USERS.add(user_id)

    artists = USER_ARTISTS.get(user_id, [])
    cities = USER_CITIES.get(user_id, [])

    await update.message.reply_text("🔍 Scanning UK providers… one moment…")

    tasks = [
        fetch_ticketmaster_uk(artists, cities),
        fetch_skiddle_uk(artists, cities),
    ]
    results = await asyncio.gather(*tasks, return_exceptions=True)

    opportunities: List[Opportunity] = []
    for res in results:
        if isinstance(res, Exception):
            logger.warning("Provider task raised: %s", res)
            continue
        opportunities.extend(res)

    if not opportunities:
        await update.message.reply_text(
            "I couldn't find any UK events from Ticketmaster/Skiddle just now.\n"
            "Check your API keys and try again later."
        )
        return

    # Filter to this user’s interests, then sort
    matches = [
        o for o in opportunities
        if matches_user(o, artists, cities)
    ]
    if not matches:
        matches = opportunities  # fallback: show global top events

    matches.sort(key=lambda o: o.trade_score, reverse=True)
    top = matches[:10]

    lines = ["🔥 *Live UK opportunities*"]
    for ev in top:
        lines.append(
            f"\n• *{ev.name}* ({ev.source}) – {ev.city}\n"
            f"  Primary: £{ev.primary_price:.2f} | Est. resale: ~£{ev.resale_price:.2f}\n"
            f"  Demand: {ev.demand_score:.1f} | Margin: {ev.margin_pct:.1f}% | "
            f"Risk: {ev.risk_score:.1f}\n"
            f"  → Trade score: *{ev.trade_score:.1f}*"
        )
        if ev.url:
            lines.append(f"  [View listing]({ev.url})")

    await update.message.reply_text("\n".join(lines), parse_mode="Markdown")


# ======================================================
# Main / webhook setup
# ======================================================

def main() -> None:
    logger.info("Starting SpectraSeat UK bot with webhooks…")

    application = ApplicationBuilder().token(BOT_TOKEN).build()

    application.add_handler(CommandHandler("start", start))
    application.add_handler(CommandHandler("ping", ping))
    application.add_handler(CommandHandler("addartist", addartist))
    application.add_handler(CommandHandler("addcity", addcity))
    application.add_handler(CommandHandler("mywatch", mywatch))
    application.add_handler(CommandHandler("hotdemo", hotdemo))
    application.add_handler(CommandHandler("ukhot", ukhot))

    application.run_webhook(
        listen="0.0.0.0",
        port=PORT,
        url_path=WEBHOOK_PATH,
        webhook_url=WEBHOOK_URL,
    )


if __name__ == "__main__":
    main()
