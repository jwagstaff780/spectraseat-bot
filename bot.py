#!/usr/bin/env python3
import os
import logging
import asyncio
import random
from typing import Dict, List, Set
from datetime import datetime

import httpx
from telegram import Update
from telegram.ext import (
    ApplicationBuilder,
    CommandHandler,
    ContextTypes,
)

# ---------- Logging ----------
logging.basicConfig(
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    level=logging.INFO,
)
logger = logging.getLogger(__name__)

# ---------- Environment ----------
BOT_TOKEN = os.environ["BOT_TOKEN"]          # set in Render
PORT = int(os.environ.get("PORT", "8000"))   # Render injects this
BASE_URL = os.environ.get("RENDER_EXTERNAL_URL", "").rstrip("/")

if not BASE_URL:
    raise RuntimeError(
        "RENDER_EXTERNAL_URL is not set. Make sure this is running as a "
        "Web Service on Render."
    )

WEBHOOK_ROUTE = "webhook"
WEBHOOK_URL = f"{BASE_URL}/{WEBHOOK_ROUTE}"

TICKETMASTER_API_KEY = os.environ.get("TICKETMASTER_API_KEY")

# ---------- In-memory “DB” (per process) ----------
USER_ARTISTS: Dict[int, List[str]] = {}
USER_CITIES: Dict[int, List[str]] = {}
KNOWN_USERS: Set[int] = set()


# ---------- Helper functions ----------
def add_to_list(store: Dict[int, List[str]], user_id: int, value: str) -> None:
    value = value.strip()
    if not value:
        return
    current = store.get(user_id, [])
    # Avoid duplicates (case-insensitive)
    if value.lower() not in [v.lower() for v in current]:
        current.append(value)
        store[user_id] = current


def format_watchlist(user_id: int) -> str:
    artists = USER_ARTISTS.get(user_id, [])
    cities = USER_CITIES.get(user_id, [])
    if not artists and not cities:
        return (
            "You’re not watching anything yet.\n"
            "Use /addartist and /addcity to teach me what to scan."
        )
    lines = ["🎧 *Your watchlist:*"]
    if artists:
        lines.append("• *Artists:* " + ", ".join(artists))
    if cities:
        lines.append("• *Cities:* " + ", ".join(cities))
    return "\n".join(lines)


# ---------- Demo market “opportunity” model ----------
class Opportunity:
    """
    Simple model of a ticket opportunity.
    """

    def __init__(
        self,
        name: str,
        city: str,
        primary_price: float,
        resale_price: float,
        demand_score: float,
        risk_score: float,
    ):
        self.name = name
        self.city = city
        self.primary_price = primary_price
        self.resale_price = resale_price
        self.demand_score = demand_score
        self.risk_score = risk_score

    @property
    def margin_score(self) -> float:
        if not self.primary_price or not self.resale_price:
            return 0.0
        return max(
            0.0,
            (self.resale_price - self.primary_price) / self.primary_price * 100.0,
        )

    @property
    def trade_score(self) -> float:
        # First version: demand + margin - risk
        return self.demand_score + self.margin_score - self.risk_score


# ---------- Real data: Ticketmaster UK helper ----------
async def fetch_ticketmaster_uk_events(
    artists: List[str],
    cities: List[str],
    max_events: int = 20,
) -> List[Opportunity]:
    """
    Fetch UK events from Ticketmaster and convert them into Opportunity objects.
    Starts simple: name/city matching + rough scoring.
    """
    if not TICKETMASTER_API_KEY:
        logger.warning("No TICKETMASTER_API_KEY set – skipping real fetch.")
        return []

    params = {
        "apikey": TICKETMASTER_API_KEY,
        "countryCode": "GB",
        "size": max_events,
        "sort": "date,asc",  # soonest first
    }
    url = "https://app.ticketmaster.com/discovery/v2/events.json"

    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.get(url, params=params)
        resp.raise_for_status()
        data = resp.json()

    events_raw = (
        data.get("_embedded", {}).get("events", [])
        if isinstance(data, dict)
        else []
    )

    results: List[Opportunity] = []

    for ev in events_raw:
        name = ev.get("name", "Unknown event")
        city = (
            ev.get("_embedded", {})
            .get("venues", [{}])[0]
            .get("city", {})
            .get("name", "Unknown")
        )

        price_ranges = ev.get("priceRanges") or []
        primary_price = None
        if price_ranges:
            # TM often returns min/max – treat min as entry price
            primary_price = price_ranges[0].get("min")

        # Matching logic
        name_lower = name.lower()
        artist_match = any(a.lower() in name_lower for a in artists) if artists else False
        city_match = any(c.lower() == city.lower() for c in cities) if cities else False

        # Time factor: nearer events get a boost
        start_date = ev.get("dates", {}).get("start", {}).get("dateTime")
        soon_boost = 0.0
        if start_date:
            try:
                dt = datetime.fromisoformat(start_date.replace("Z", "+00:00"))
                days = max(0.0, (dt - datetime.utcnow()).days)
                soon_boost = max(0.0, 30.0 - days)  # nearer = higher
            except Exception:
                pass

        demand_score = 40.0  # base
        if artist_match:
            demand_score += 30.0
        if city_match:
            demand_score += 15.0
        demand_score += soon_boost * 0.5

        # Rough resale estimate
        if primary_price:
            resale_price = primary_price * 1.4
        else:
            primary_price = 0.0
            resale_price = 0.0

        risk_score = 20.0  # fixed for now

        results.append(
            Opportunity(
                name=name,
                city=city,
                primary_price=float(primary_price or 0.0),
                resale_price=float(resale_price or 0.0),
                demand_score=demand_score,
                risk_score=risk_score,
            )
        )

    results.sort(key=lambda e: e.trade_score, reverse=True)
    return results


# ---------- Command handlers ----------
async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    KNOWN_USERS.add(user_id)

    text = (
        "✅ Bot is online via Render (webhook mode).\n\n"
        "I’m your *market radar* for events.\n\n"
        "Commands:\n"
        "• /addartist Coldplay\n"
        "• /addcity London\n"
        "• /mywatch – show what you’re tracking\n"
        "• /hotdemo – demo of how I rank hot opportunities\n"
        "• /ukhot – live UK events from Ticketmaster\n"
        "• /ping – health check\n\n"
        "Right now this is a demo brain + Ticketmaster UK.\n"
        "Next step is wiring in more ticket + social data."
    )
    await update.message.reply_text(text, parse_mode="Markdown")


async def ping(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text("🏓 Pong – market radar is alive.")


async def addartist(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    KNOWN_USERS.add(user_id)

    if not context.args:
        await update.message.reply_text("Usage: /addartist Artist Name")
        return

    artist = " ".join(context.args)
    add_to_list(USER_ARTISTS, user_id, artist)
    await update.message.reply_text(
        f"🎧 Added artist to your watchlist: *{artist}*",
        parse_mode="Markdown",
    )


async def addcity(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    KNOWN_USERS.add(user_id)

    if not context.args:
        await update.message.reply_text("Usage: /addcity City Name")
        return

    city = " ".join(context.args)
    add_to_list(USER_CITIES, user_id, city)
    await update.message.reply_text(
        f"🏙 Added city to your watchlist: *{city}*",
        parse_mode="Markdown",
    )


async def mywatch(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    KNOWN_USERS.add(user_id)

    text = format_watchlist(user_id)
    await update.message.reply_text(text, parse_mode="Markdown")


async def hotdemo(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """
    DEMO: show how the market brain will rank opportunities.
    Uses fake data so you can see the behaviour.
    """
    user_id = update.effective_user.id
    KNOWN_USERS.add(user_id)

    artists = USER_ARTISTS.get(user_id, []) or ["Unknown Artist"]
    cities = USER_CITIES.get(user_id, []) or ["London"]

    fake_events: List[Opportunity] = []
    for i in range(3):
        artist = random.choice(artists)
        city = random.choice(cities)
        primary_price = random.choice([45.0, 60.0, 80.0])
        resale_price = primary_price * random.choice([1.1, 1.3, 1.5, 1.8])
        demand_score = random.uniform(40, 90)
        risk_score = random.uniform(5, 30)
        fake_events.append(
            Opportunity(
                name=f"{artist} Arena Show #{i+1}",
                city=city,
                primary_price=primary_price,
                resale_price=resale_price,
                demand_score=demand_score,
                risk_score=risk_score,
            )
        )

    fake_events.sort(key=lambda e: e.trade_score, reverse=True)

    lines = ["🔥 *Demo hot opportunities (fake data)*"]
    for ev in fake_events:
        lines.append(
            f"\n• *{ev.name}* – {ev.city}\n"
            f"  Primary: £{ev.primary_price:.2f} | Resale: ~£{ev.resale_price:.2f}\n"
            f"  Demand: {ev.demand_score:.1f} | Margin: {ev.margin_score:.1f}% | "
            f"Risk: {ev.risk_score:.1f}\n"
            f"  → Trade score: *{ev.trade_score:.1f}*"
        )

    await update.message.reply_text("\n".join(lines), parse_mode="Markdown")


async def ukhot(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """
    Real-data UK hot events (Ticketmaster only, for now).
    Uses your watchlist as hints (artists + cities).
    """
    user_id = update.effective_user.id
    KNOWN_USERS.add(user_id)

    artists = USER_ARTISTS.get(user_id, [])
    cities = USER_CITIES.get(user_id, [])

    await update.message.reply_text("🔍 Scanning Ticketmaster UK… one sec…")

    try:
        events = await fetch_ticketmaster_uk_events(artists, cities, max_events=20)
    except Exception:
        logger.exception("Ticketmaster fetch failed")
        await update.message.reply_text(
            "⚠️ I hit a problem talking to Ticketmaster. "
            "We’ll debug the API key/limits later."
        )
        return

    if not events:
        await update.message.reply_text(
            "I couldn’t find any strong UK events right now.\n"
            "Try adding /addartist and /addcity so I know what to hunt for."
        )
        return

    lines = ["🔥 *Live UK events from Ticketmaster*"]
    for ev in events[:10]:  # show top 10
        lines.append(
            f"\n• *{ev.name}* – {ev.city}\n"
            f"  Primary (approx): £{ev.primary_price:.2f}\n"
            f"  Margin (rough): {ev.margin_score:.1f}%\n"
            f"  Trade score: *{ev.trade_score:.1f}*"
        )

    await update.message.reply_text("\n".join(lines), parse_mode="Markdown")


# ---------- Background scanner (very light) ----------
async def scan_markets(context: ContextTypes.DEFAULT_TYPE):
    """
    Placeholder background scanner.
    Right now just logs that it ran; later it will pull real feeds
    and push alerts.
    """
    logger.info("Periodic market scan tick. Known users: %s", len(KNOWN_USERS))


# ---------- Main entry ----------
async def main():
    app = ApplicationBuilder().token(BOT_TOKEN).build()

    # Command handlers
    app.add_handler(CommandHandler("start", start))
    app.add_handler(CommandHandler("ping", ping))
    app.add_handler(CommandHandler("addartist", addartist))
    app.add_handler(CommandHandler("addcity", addcity))
    app.add_handler(CommandHandler("mywatch", mywatch))
    app.add_handler(CommandHandler("hotdemo", hotdemo))
    app.add_handler(CommandHandler("ukhot", ukhot))

    # Background job (every 10 minutes)
    app.job_queue.run_repeating(scan_markets, interval=600, first=60)

    # Run in webhook mode on Render
    await app.run_webhook(
        listen="0.0.0.0",
        port=PORT,
        url_path=WEBHOOK_ROUTE,
        webhook_url=WEBHOOK_URL,
    )


if __name__ == "__main__":
    asyncio.run(main())
