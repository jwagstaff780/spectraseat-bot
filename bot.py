import os
import logging
import asyncio
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Dict, List, Set, Optional

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
# Environment / Render config
# ======================================================

BOT_TOKEN = os.environ["BOT_TOKEN"]

# Ticketmaster – support either env var name
TM_API_KEY = os.environ.get("TM_API_KEY") or os.environ.get("TICKETMASTER_API_KEY")

# Skiddle API key
SKIDDLE_API_KEY = os.environ.get("SKIDDLE_API_KEY")

PORT = int(os.environ.get("PORT", "10000"))
BASE_URL = os.environ.get("RENDER_EXTERNAL_URL", "").rstrip("/")
if not BASE_URL:
    raise RuntimeError(
        "RENDER_EXTERNAL_URL is not set. On Render it is injected automatically "
        "for Web Services."
    )

WEBHOOK_PATH = BOT_TOKEN
WEBHOOK_URL = f"{BASE_URL}/{WEBHOOK_PATH}"

# ======================================================
# In-memory state
# ======================================================

KNOWN_USERS: Set[int] = set()          # chat IDs that did /start
ALERTED_EVENT_IDS: Set[str] = set()    # event IDs we already alerted on (per process)
LAST_SCAN_TIME: Optional[datetime] = None
LAST_SCAN_COUNT: int = 0

# Background radar task handle
RADAR_TASK: Optional[asyncio.Task] = None

# “Radar focus” – internal, you don’t have to type these anywhere
TRENDING_ARTISTS = [
    "Central Cee",
    "Drake",
    "Taylor Swift",
    "Fred again",
    "Esdee Kid",
    "Meekz",
    "Booter Bee",
    "WHP",
    "Warehouse Project",
    "Mint Festival",
    "Parklife",
]

TRENDING_FIGHTERS = [
    "Jake Paul",
    "Anthony Joshua",
    "Tyson Fury",
    "KSI",
    "Deontay Wilder",
    "Boxing",
    "Fight Night",
]

UK_CITIES = [
    "London",
    "Manchester",
    "Leeds",
    "Birmingham",
    "Liverpool",
    "Glasgow",
    "Edinburgh",
    "Bristol",
    "Newcastle",
]

# ======================================================
# Model
# ======================================================

@dataclass
class Opportunity:
    event_id: str
    name: str
    city: str
    venue: str
    date_str: str
    source: str          # e.g. "TM-Music", "TM-Boxing", "Skiddle"
    primary_min: float
    primary_max: float
    demand_score: float  # 0-100
    risk_score: float    # 0-100
    url: Optional[str] = None
    tags: Optional[List[str]] = None

    @property
    def margin_pct_guess(self) -> float:
        # Simple proxy: cheaper tickets with high demand -> higher potential %
        if self.primary_min <= 0:
            return 0.0
        base = 10.0
        cheap_boost = 10.0 if self.primary_min <= 50 else 0.0
        demand_boost = (self.demand_score - 50) * 0.4
        return max(0.0, base + cheap_boost + demand_boost)

    @property
    def trade_score(self) -> float:
        # First pass: demand + margin guess – risk
        return self.demand_score + self.margin_pct_guess - self.risk_score


# ======================================================
# Ticketmaster helpers
# ======================================================

async def _tm_get_events(params: Dict) -> List[Dict]:
    """Low-level helper to call Ticketmaster Discovery API."""
    if not TM_API_KEY:
        logger.warning("No TM_API_KEY / TICKETMASTER_API_KEY set; skipping Ticketmaster.")
        return []

    base_params = {
        "apikey": TM_API_KEY,
        "countryCode": "GB",
        "size": 100,
        "sort": "date,asc",
        "locale": "*",
    }
    base_params.update(params)

    url = "https://app.ticketmaster.com/discovery/v2/events.json"

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(url, params=base_params)
            resp.raise_for_status()
            data = resp.json()
    except Exception as e:
        logger.warning("Ticketmaster request failed: %s", e)
        return []

    return data.get("_embedded", {}).get("events", [])


def _parse_price(ev: Dict) -> (float, float):
    """Extract min/max price if present."""
    primary_min = 0.0
    primary_max = 0.0
    for pr in ev.get("priceRanges", []):
        try:
            mn = float(pr.get("min"))
            mx = float(pr.get("max"))
        except Exception:
            continue
        if primary_min == 0.0 or mn < primary_min:
            primary_min = mn
        if mx > primary_max:
            primary_max = mx
    return primary_min, primary_max


def _parse_basic_event_fields(ev: Dict) -> Dict:
    """Normalize name, city, venue, date."""
    name = ev.get("name") or "Unknown Event"
    venue = "Unknown venue"
    city = "Unknown"
    try:
        v = (ev.get("_embedded", {}).get("venues") or [])[0]
        venue = v.get("name") or venue
        city = (v.get("city") or {}).get("name") or city
    except Exception:
        pass

    start_info = (ev.get("dates") or {}).get("start") or {}
    dt_raw = start_info.get("dateTime") or start_info.get("localDate")
    date_str = dt_raw or "Unknown date"
    if dt_raw:
        try:
            if "T" in dt_raw:
                dt = datetime.fromisoformat(dt_raw.replace("Z", "+00:00"))
            else:
                dt = datetime.fromisoformat(dt_raw + "T00:00:00+00:00")
            date_str = dt.strftime("%d %b %Y")
        except Exception:
            pass

    return {
        "name": name,
        "venue": venue,
        "city": city,
        "date_str": date_str,
    }


# ======================================================
# Providers: Ticketmaster music + boxing
# ======================================================

async def fetch_tm_music_hot() -> List[Opportunity]:
    """Fetch hot UK music events likely to be money-makers."""
    if not TM_API_KEY:
        return []

    now = datetime.now(timezone.utc)
    params = {
        "classificationName": "music",
        "startDateTime": now.isoformat(timespec="seconds").replace("+00:00", "Z"),
        "endDateTime": (now + timedelta(days=60)).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "keyword": " ".join(TRENDING_ARTISTS[:5]),
    }

    events = await _tm_get_events(params)
    out: List[Opportunity] = []

    for ev in events:
        base = _parse_basic_event_fields(ev)
        event_id = ev.get("id") or base["name"]

        primary_min, primary_max = _parse_price(ev)

        name_lower = base["name"].lower()
        demand_score = 50.0

        # UK city
        if any(c.lower() == base["city"].lower() for c in UK_CITIES):
            demand_score += 10.0

        # Trending artist
        for artist in TRENDING_ARTISTS:
            if artist.lower() in name_lower:
                demand_score += 25.0
                break

        # Cheap entry
        if primary_min > 0 and primary_min <= 50:
            demand_score += 10.0

        risk_score = 15.0  # gigs lower risk

        tags: List[str] = []
        if primary_min > 0 and primary_min <= 40:
            tags.append("cheap-entry")
        if demand_score >= 80:
            tags.append("hype")

        out.append(
            Opportunity(
                event_id=event_id,
                name=base["name"],
                city=base["city"],
                venue=base["venue"],
                date_str=base["date_str"],
                source="TM-Music",
                primary_min=primary_min,
                primary_max=primary_max,
                demand_score=demand_score,
                risk_score=risk_score,
                url=ev.get("url"),
                tags=tags,
            )
        )

    return out


async def fetch_tm_boxing_hot() -> List[Opportunity]:
    """Fetch big boxing / fight-night style events (Jake Paul, AJ, etc.)."""
    if not TM_API_KEY:
        return []

    now = datetime.now(timezone.utc)
    params = {
        "classificationName": "sports",
        "startDateTime": now.isoformat(timespec="seconds").replace("+00:00", "Z"),
        "endDateTime": (now + timedelta(days=90)).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "keyword": " ".join(TRENDING_FIGHTERS),
    }

    events = await _tm_get_events(params)
    out: List[Opportunity] = []

    for ev in events:
        base = _parse_basic_event_fields(ev)
        event_id = ev.get("id") or base["name"]

        primary_min, primary_max = _parse_price(ev)
        name_lower = base["name"].lower()

        demand_score = 60.0

        for fighter in TRENDING_FIGHTERS:
            if fighter.lower() in name_lower:
                demand_score += 30.0
                break

        risk_score = 25.0  # higher risk for fights

        tags: List[str] = ["boxing"]
        if "jake paul" in name_lower and "anthony joshua" in name_lower:
            tags.append("mega-fight")
            demand_score += 15.0

        if primary_min > 0 and primary_min <= 80:
            demand_score += 10.0
            tags.append("affordable-entry")

        out.append(
            Opportunity(
                event_id=event_id,
                name=base["name"],
                city=base["city"],
                venue=base["venue"],
                date_str=base["date_str"],
                source="TM-Boxing",
                primary_min=primary_min,
                primary_max=primary_max,
                demand_score=demand_score,
                risk_score=risk_score,
                url=ev.get("url"),
                tags=tags,
            )
        )

    return out


# ======================================================
# Provider: Skiddle UK
# ======================================================

async def fetch_skiddle_hot() -> List[Opportunity]:
    """
    Fetch hot UK events from Skiddle.

    Focus: raves, club nights, festivals, live music in UK cities.
    """
    if not SKIDDLE_API_KEY:
        return []

    url = "https://www.skiddle.com/api/v1/events/"
    params = {
        "api_key": SKIDDLE_API_KEY,
        "country": "UK",
        "limit": 100,
        "order": "date",
    }

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(url, params=params)
            resp.raise_for_status()
            data = resp.json()
    except Exception as e:
        logger.warning("Skiddle request failed: %s", e)
        return []

    results = data.get("results", [])
    out: List[Opportunity] = []

    for ev in results:
        name = ev.get("eventname") or "Unknown Skiddle Event"
        town = ev.get("town") or ev.get("venue", "") or "Unknown"
        venue_name = ev.get("venue", "") or "Unknown venue"
        date_raw = ev.get("date") or ""
        date_str = date_raw
        try:
            dt = datetime.strptime(date_raw, "%Y-%m-%d")
            date_str = dt.strftime("%d %b %Y")
        except Exception:
            pass

        primary_min = 0.0
        primary_max = 0.0
        try:
            if ev.get("minprice"):
                primary_min = float(ev["minprice"])
            if ev.get("maxprice"):
                primary_max = float(ev["maxprice"])
        except Exception:
            pass

        name_lower = name.lower()
        demand_score = 50.0

        if any(c.lower() in town.lower() for c in UK_CITIES):
            demand_score += 10.0

        for artist in TRENDING_ARTISTS:
            if artist.lower() in name_lower:
                demand_score += 25.0
                break

        if primary_min > 0 and primary_min <= 35:
            demand_score += 10.0

        risk_score = 18.0

        tags: List[str] = ["Skiddle"]
        if "festival" in name_lower:
            tags.append("festival")
        if primary_min > 0 and primary_min <= 25:
            tags.append("cheap-entry")
        if demand_score >= 80:
            tags.append("hype")

        event_id = str(ev.get("id") or name)
        link = ev.get("link")

        out.append(
            Opportunity(
                event_id=event_id,
                name=name,
                city=town,
                venue=venue_name,
                date_str=date_str,
                source="Skiddle",
                primary_min=primary_min,
                primary_max=primary_max,
                demand_score=demand_score,
                risk_score=risk_score,
                url=link,
                tags=tags,
            )
        )

    return out


# ======================================================
# Radar scan + alerts
# ======================================================

MONEY_MAKER_THRESHOLD = 70.0  # trade_score threshold for alerts


async def run_radar_scan() -> List[Opportunity]:
    """Pull hot music + boxing + Skiddle events and return sorted opportunities."""
    music, boxing, skiddle = await asyncio.gather(
        fetch_tm_music_hot(),
        fetch_tm_boxing_hot(),
        fetch_skiddle_hot(),
    )
    all_opps = music + boxing + skiddle
    all_opps.sort(key=lambda o: o.trade_score, reverse=True)
    return all_opps


async def send_alerts_for_hot(bot, opps: List[Opportunity]) -> None:
    """
    Send DM alerts for new high-scoring opportunities
    to everyone in KNOWN_USERS.
    """
    global LAST_SCAN_TIME, LAST_SCAN_COUNT, ALERTED_EVENT_IDS

    LAST_SCAN_TIME = datetime.now(timezone.utc)
    LAST_SCAN_COUNT = len(opps)

    hot_opps = [o for o in opps if o.trade_score >= MONEY_MAKER_THRESHOLD]
    new_hot = [o for o in hot_opps if o.event_id not in ALERTED_EVENT_IDS]

    if not new_hot:
        logger.info("No NEW hot events above threshold this round.")
        return

    new_hot = new_hot[:5]  # cap alerts per scan

    for o in new_hot:
        ALERTED_EVENT_IDS.add(o.event_id)

    for user_id in list(KNOWN_USERS):
        for opp in new_hot:
            tags_str = ""
            if opp.tags:
                tags_str = " | " + ", ".join(opp.tags)

            if opp.primary_min > 0 and opp.primary_max > 0:
                price_line = f"Price: £{opp.primary_min:.0f}–£{opp.primary_max:.0f}"
            elif opp.primary_min > 0:
                price_line = f"From: £{opp.primary_min:.0f}"
            else:
                price_line = "Price: unknown"

            lines = [
                f"🚨 *Money-maker radar hit* ({opp.source})",
                "",
                f"*{opp.name}*",
                f"{opp.venue} – {opp.city} – {opp.date_str}",
                price_line,
                f"Demand: {opp.demand_score:.1f} | Margin guess: {opp.margin_pct_guess:.1f}% | Risk: {opp.risk_score:.1f}",
                f"Trade score: *{opp.trade_score:.1f}*{tags_str}",
            ]
            if opp.url:
                lines.append("")
                lines.append(f"[View listing]({opp.url})")

            text = "\n".join(lines)

            try:
                await bot.send_message(
                    chat_id=user_id,
                    text=text,
                    parse_mode="Markdown",
                    disable_web_page_preview=False,
                )
            except Exception as e:
                logger.warning("Failed to send alert to %s: %s", user_id, e)


async def radar_background_loop(app) -> None:
    """
    Pure asyncio background loop.
    Runs forever while the app is alive, every ~5 minutes.
    """
    logger.info("Background radar loop started.")
    while True:
        try:
            if KNOWN_USERS:
                logger.info("Background radar tick – scanning providers…")
                opps = await run_radar_scan()
                await send_alerts_for_hot(app.bot, opps)
            else:
                logger.info("No known users yet – skipping radar tick.")
        except Exception as e:
            logger.warning("Radar loop error: %s", e)

        await asyncio.sleep(300)  # 5 minutes


# ======================================================
# Commands
# ======================================================

async def cmd_start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    global RADAR_TASK

    user_id = update.effective_user.id
    KNOWN_USERS.add(user_id)

    # Start background radar once (after first /start)
    if RADAR_TASK is None or RADAR_TASK.done():
        RADAR_TASK = asyncio.create_task(radar_background_loop(context.application))

    text = (
        "✅ SpectraSeat radar online.\n\n"
        "You don’t need to configure anything – I automatically scan UK Ticketmaster "
        "and Skiddle for *hot music events* and *big boxing cards* (Jake Paul, "
        "Anthony Joshua-type fights, etc.).\n\n"
        "Every ~5 minutes I:\n"
        "• Pull fresh UK events (Ticketmaster + Skiddle)\n"
        "• Score them for demand / margin / risk\n"
        "• DM you when something crosses the money-maker threshold.\n\n"
        "Commands:\n"
        "• /status – see last scan info\n"
        "• /scan – force a manual radar scan now\n"
        "• /ping – simple health check\n\n"
        "I auto-handle artists/venues from the hottest markets – you don’t need "
        "/addartist or /addcity anymore."
    )
    await update.message.reply_text(text, parse_mode="Markdown")


async def cmd_ping(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text("🏓 Pong – radar is alive.")


async def cmd_status(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    KNOWN_USERS.add(user_id)

    if LAST_SCAN_TIME is None:
        await update.message.reply_text(
            "I haven’t completed a radar scan yet. Give me a moment, or use /scan to trigger one."
        )
        return

    when = LAST_SCAN_TIME.astimezone(timezone.utc).strftime("%d %b %Y %H:%M UTC")
    msg = (
        f"📊 Last radar scan: {when}\n"
        f"Events evaluated: {LAST_SCAN_COUNT}\n"
        f"Alerted events this session: {len(ALERTED_EVENT_IDS)}\n\n"
        "I scan automatically every ~5 minutes while I’m running."
    )
    await update.message.reply_text(msg)


async def cmd_scan(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Manual radar scan for an instant snapshot (no dependency on background loop)."""
    user_id = update.effective_user.id
    KNOWN_USERS.add(user_id)

    msg = await update.message.reply_text("📡 Running radar scan now…")

    opps = await run_radar_scan()
    if not opps:
        await msg.edit_text(
            "I couldn’t pull any events just now. Check API keys or try again later."
        )
        return

    # also update last-scan stats (but don't mark ALERTED_EVENT_IDS etc.)
    global LAST_SCAN_TIME, LAST_SCAN_COUNT
    LAST_SCAN_TIME = datetime.now(timezone.utc)
    LAST_SCAN_COUNT = len(opps)

    top = opps[:7]
    lines = ["🔥 *Manual radar snapshot*", ""]
    for opp in top:
        tags_str = ""
        if opp.tags:
            tags_str = " | " + ", ".join(opp.tags)

        if opp.primary_min > 0 and opp.primary_max > 0:
            price_line = f"Price: £{opp.primary_min:.0f}–£{opp.primary_max:.0f}"
        elif opp.primary_min > 0:
            price_line = f"From: £{opp.primary_min:.0f}"
        else:
            price_line = "Price: unknown"

        lines.append(
            f"*{opp.name}* ({opp.source})\n"
            f"{opp.venue} – {opp.city} – {opp.date_str}\n"
            f"{price_line}\n"
            f"Demand: {opp.demand_score:.1f} | Margin guess: {opp.margin_pct_guess:.1f}% | "
            f"Risk: {opp.risk_score:.1f}\n"
            f"Trade score: *{opp.trade_score:.1f}*{tags_str}\n"
            f"{opp.url or ''}\n"
        )

    await msg.edit_text(
        "\n".join(lines),
        parse_mode="Markdown",
        disable_web_page_preview=False,
    )


# ======================================================
# Main
# ======================================================

def main() -> None:
    logger.info("Starting SpectraSeat autonomous UK radar bot (Ticketmaster + Skiddle)…")

    application = (
        ApplicationBuilder()
        .token(BOT_TOKEN)
        .build()
    )

    # Commands
    application.add_handler(CommandHandler("start", cmd_start))
    application.add_handler(CommandHandler("ping", cmd_ping))
    application.add_handler(CommandHandler("status", cmd_status))
    application.add_handler(CommandHandler("scan", cmd_scan))
    # Backwards-compat: /ukhot will just trigger a manual scan
    application.add_handler(CommandHandler("ukhot", cmd_scan))

    application.run_webhook(
        listen="0.0.0.0",
        port=PORT,
        url_path=WEBHOOK_PATH,
        webhook_url=WEBHOOK_URL,
    )


if __name__ == "__main__":
    main()
