import os
import logging
import asyncio
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import List, Set, Optional, Tuple
import httpx
import json
import re

from telegram import (
    Update,
    InlineKeyboardButton,
    InlineKeyboardMarkup,
)
from telegram.ext import (
    ApplicationBuilder,
    CommandHandler,
    CallbackQueryHandler,
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
# Environment
# ======================================================

BOT_TOKEN = os.environ["BOT_TOKEN"]
ADMIN_CHAT_ID = os.environ.get("ADMIN_CHAT_ID")

# ======================================================
# In-memory state
# ======================================================

KNOWN_USERS: Set[int] = set()          # chat IDs that did /start
ALERTED_EVENT_IDS: Set[str] = set()    # event IDs we already alerted on (per process)
LAST_SCAN_TIME: Optional[datetime] = None
LAST_SCAN_COUNT: int = 0

RADAR_LOOP_STARTED: bool = False

# Provider toggles (can be changed via HUD)
PROVIDER_CONFIG = {
    "tm_music": True,
    "tm_boxing": True,
}

# Radar config
MONEY_MAKER_THRESHOLD = 70.0  # trade_score threshold for alerts
RADAR_INTERVAL_SECONDS = 300  # 5 minutes

# Radar focus – names for scoring boosts
TRENDING_ARTISTS = [
    "Central Cee",
    "Drake",
    "Taylor Swift",
    "Fred again",
    "WHP",
    "Warehouse Project",
    "Mint Festival",
    "Parklife",
    "Creamfields",
    "Wireless",
    "TRNSMT",
]

TRENDING_FIGHTERS = [
    "Jake Paul",
    "Anthony Joshua",
    "Tyson Fury",
    "KSI",
    "UFC",
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
# Ticketmaster watchlists (festivals + boxing)
# ======================================================

TM_MUSIC_WATCHLIST: List[dict] = [
    {
        "event_id": "parklife_2026_weekend",
        "name": "Rockstar Energy presents Parklife 2026 (Weekend)",
        "city": "Manchester",
        "venue": "Heaton Park",
        "date_str": "20–21 Jun 2026",
        "url": "https://www.ticketmaster.co.uk/parklife-2026-weekend-ticket-manchester-20-06-2026/event/3E00635D8DCC3331",
    },
    {
        "event_id": "wireless_2025_weekend",
        "name": "Wireless Festival 2025 (Weekend)",
        "city": "London",
        "venue": "Finsbury Park",
        "date_str": "11–13 Jul 2025",
        "url": "https://www.ticketmaster.co.uk/wireless-festival-tickets/artist/28989",
    },
    {
        "event_id": "creamfields_2025_4day",
        "name": "Rockstar Energy presents Creamfields 2025 (4 Day Camping)",
        "city": "Daresbury",
        "venue": "Creamfields, Cheshire",
        "date_str": "21–24 Aug 2025",
        "url": "https://www.ticketmaster.co.uk/creamfields-2025-4-day-camping-standard-cheshire-08-21-2025/event/37006109C7B86B50",
    },
    {
        "event_id": "reading_leeds_2026",
        "name": "Reading & Leeds Festival 2026",
        "city": "Reading/Leeds",
        "venue": "Richfield Ave / Bramham Park",
        "date_str": "28–30 Aug 2026",
        "url": "https://www.ticketmaster.co.uk/reading-and-leeds-festival",
    },
    {
        "event_id": "isle_of_wight_2026",
        "name": "Isle of Wight Festival 2026 (Weekend)",
        "city": "Newport",
        "venue": "Isle of Wight Festival",
        "date_str": "18–21 Jun 2026",
        "url": "https://www.ticketmaster.co.uk/isle-of-wight-festival-2026-weekend-ticket-newport-18-06-2026/event/1F006339AF837869",
    },
    {
        "event_id": "trnsmt_2026_3day",
        "name": "TRNSMT Festival 2026 (3 Day Ticket)",
        "city": "Glasgow",
        "venue": "Glasgow Green",
        "date_str": "19–21 Jun 2026",
        "url": "https://www.ticketmaster.co.uk/trnsmt-2026-3-day-ticket-glasgow-19-06-2026/event/3600636394705B24",
    },
]

TM_BOXING_WATCHLIST: List[dict] = [
    {
        "event_id": "itauma_franklin_2026",
        "name": "Itauma vs Franklin – The Magnificent Seven",
        "city": "Manchester",
        "venue": "Co-op Live",
        "date_str": "24 Jan 2026",
        "url": "https://www.ticketmaster.co.uk/moses-itauma-tickets/artist/5651848",
    },
    {
        "event_id": "chisora_wallin_2025",
        "name": "Derek Chisora vs Otto Wallin – The Last Dance",
        "city": "Manchester",
        "venue": "Co-op Live",
        "date_str": "08 Feb 2025",
        "url": "https://www.ticketmaster.co.uk/dereck-chisora-tickets/artist/1605089",
    },
    {
        "event_id": "misfits_x_series_22",
        "name": "Misfits & DAZN: X Series 22 (Darren Till vs Rockhold)",
        "city": "Manchester",
        "venue": "AO Arena",
        "date_str": "30 Aug 2025",
        "url": "https://www.ticketmaster.co.uk/venue-premium-tickets-misfits-dazn-x-series-22-manchester-30-08-2025/event/1F0062F5A5A20EDE",
    },
    {
        "event_id": "matchroom_boxing_uk",
        "name": "Matchroom Boxing UK – Major Cards",
        "city": "UK-wide",
        "venue": "Various arenas",
        "date_str": "2025–26",
        "url": "https://www.ticketmaster.co.uk/matchroom-boxing-uk-tickets/artist/5363334",
    },
    {
        "event_id": "championship_boxing",
        "name": "Championship Boxing – Title Fights",
        "city": "UK-wide",
        "venue": "Various arenas",
        "date_str": "2025–26",
        "url": "https://www.ticketmaster.co.uk/championship-boxing-tickets/artist/838100",
    },
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
    source: str          # e.g. "TM-Festival", "TM-Boxing"
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
# HTML scraping helpers (no Ticketmaster API)
# ======================================================

async def fetch_html(url: str, max_retries: int = 3) -> Optional[str]:
    """
    Fetch a URL with basic retry/backoff.
    No API keys, just plain HTML like a browser.
    """
    delay = 5
    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/120.0.0.0 Safari/537.36"
        ),
        "Accept-Language": "en-GB,en;q=0.9",
    }

    for attempt in range(1, max_retries + 1):
        try:
            async with httpx.AsyncClient(timeout=20.0, headers=headers) as client:
                resp = await client.get(url)
            if resp.status_code == 200:
                return resp.text

            if resp.status_code in (429, 500, 502, 503, 504):
                logger.warning(
                    "HTML fetch got %s for %s (attempt %d/%d), retrying in %ds…",
                    resp.status_code,
                    url,
                    attempt,
                    max_retries,
                    delay,
                )
                await asyncio.sleep(delay)
                delay = min(delay * 2, 60)
                continue

            logger.warning(
                "Unexpected status %s for %s – not retrying.",
                resp.status_code,
                url,
            )
            return None
        except Exception as e:
            logger.warning(
                "Error fetching %s on attempt %d/%d: %s",
                url,
                attempt,
                max_retries,
                e,
            )
            await asyncio.sleep(delay)
            delay = min(delay * 2, 60)

    logger.warning("Failed to fetch %s after %d attempts.", url, max_retries)
    return None


def extract_prices_from_html(html: str) -> Tuple[float, float]:
    """
    Try to find ticket prices inside the Ticketmaster event HTML.

    If the page clearly says there are no events or tickets,
    return (-1.0, -1.0) so the caller can skip this opportunity.
    """
    lowered = html.lower()

    # Detect "no events" / "no tickets" type pages
    no_events_markers = [
        "there are no events currently scheduled",
        "sorry, there are no shows for",
        "no events found",
        "no upcoming events",
    ]
    if any(phrase in lowered for phrase in no_events_markers):
        return -1.0, -1.0  # special value meaning "skip this one"

    prices: List[float] = []

    # Try to find a JSON block that mentions "offers" or "price"
    m = re.search(r'(\{[^<]*?"offers"[^<]*?\})', html, re.DOTALL)
    if m:
        try:
            data = json.loads(m.group(1))

            def walk(obj):
                if isinstance(obj, dict):
                    if "price" in obj and isinstance(obj["price"], (int, float, str)):
                        try:
                            prices.append(float(obj["price"]))
                        except ValueError:
                            pass
                    for v in obj.values():
                        walk(v)
                elif isinstance(obj, list):
                    for item in obj:
                        walk(item)

            walk(data)
        except json.JSONDecodeError:
            pass

    # Fallback: simple regex for "£123" style prices
    if not prices:
        for match in re.findall(r"[£](\d+(?:\.\d{1,2})?)", html):
            try:
                prices.append(float(match))
            except ValueError:
                continue

    if not prices:
        return 0.0, 0.0

    return float(min(prices)), float(max(prices))


async def scrape_ticketmaster_prices(url: str) -> Tuple[float, float]:
    """
    Full pipeline: fetch HTML, then extract price range.
    Returns (primary_min, primary_max).
    """
    html = await fetch_html(url)
    if html is None:
        return 0.0, 0.0
    return extract_prices_from_html(html)


# ======================================================
# Providers: Ticketmaster watchlists (music + boxing)
# ======================================================

async def fetch_tm_music_hot() -> List[Opportunity]:
    """Fetch hot music/festival events from your Ticketmaster watchlist."""
    if not PROVIDER_CONFIG.get("tm_music", True):
        return []
    if not TM_MUSIC_WATCHLIST:
        logger.info("No TM_MUSIC_WATCHLIST entries configured yet.")
        return []

    out: List[Opportunity] = []

    for cfg in TM_MUSIC_WATCHLIST:
        url = cfg.get("url")
        if not url:
            continue

        primary_min, primary_max = await scrape_ticketmaster_prices(url)

        # If the page has no events/tickets, skip it entirely
        if primary_min < 0 and primary_max < 0:
            logger.info("Skipping %s – no events currently scheduled.", url)
            continue

        name = cfg.get("name", "Unknown Event")
        city = cfg.get("city", "Unknown")
        venue = cfg.get("venue", "Unknown venue")
        date_str = cfg.get("date_str", "Unknown date")
        event_id = cfg.get("event_id", name)

        # Demand scoring
        name_lower = name.lower()
        demand_score = 55.0  # base slightly higher for festivals

        # Boost if UK city of interest
        if any(c.lower() == city.lower() for c in UK_CITIES):
            demand_score += 10.0

        # Boost if trending artist/brand mentioned
        for artist in TRENDING_ARTISTS:
            if artist.lower() in name_lower:
                demand_score += 25.0
                break

        # Boost if cheap entry
        if primary_min > 0 and primary_min <= 80:
            demand_score += 10.0

        # Risk – festivals medium risk (weather, travel)
        risk_score = 20.0

        tags: List[str] = ["festival"]
        if primary_min > 0 and primary_min <= 60:
            tags.append("cheap-entry")
        if demand_score >= 80:
            tags.append("hype")

        opp = Opportunity(
            event_id=event_id,
            name=name,
            city=city,
            venue=venue,
            date_str=date_str,
            source="TM-Festival",
            primary_min=primary_min,
            primary_max=primary_max,
            demand_score=demand_score,
            risk_score=risk_score,
            url=url,
            tags=tags,
        )
        out.append(opp)

    return out


async def fetch_tm_boxing_hot() -> List[Opportunity]:
    """Fetch big boxing / fight-night events from your Ticketmaster watchlist."""
    if not PROVIDER_CONFIG.get("tm_boxing", True):
        return []
    if not TM_BOXING_WATCHLIST:
        logger.info("No TM_BOXING_WATCHLIST entries configured yet.")
        return []

    out: List[Opportunity] = []

    for cfg in TM_BOXING_WATCHLIST:
        url = cfg.get("url")
        if not url:
            continue

        primary_min, primary_max = await scrape_ticketmaster_prices(url)

        # If the page has no events/tickets, skip it entirely
        if primary_min < 0 and primary_max < 0:
            logger.info("Skipping %s – no events currently scheduled.", url)
            continue

        name = cfg.get("name", "Unknown Event")
        city = cfg.get("city", "Unknown")
        venue = cfg.get("venue", "Unknown venue")
        date_str = cfg.get("date_str", "Unknown date")
        event_id = cfg.get("event_id", name)

        name_lower = name.lower()
        demand_score = 60.0

        # Heavy boost if big-name fight
        for fighter in TRENDING_FIGHTERS:
            if fighter.lower() in name_lower:
                demand_score += 30.0
                break

        # Boxing is higher risk (injury, cancellations, undercards)
        risk_score = 25.0

        tags: List[str] = ["boxing"]
        if "jake paul" in name_lower or "ksi" in name_lower:
            tags.append("crossover")
        if "anthony joshua" in name_lower or "tyson fury" in name_lower or "ufc" in name_lower:
            tags.append("elite")
        if primary_min > 0 and primary_min <= 120:
            demand_score += 10.0
            tags.append("affordable-entry")

        opp = Opportunity(
            event_id=event_id,
            name=name,
            city=city,
            venue=venue,
            date_str=date_str,
            source="TM-Boxing",
            primary_min=primary_min,
            primary_max=primary_max,
            demand_score=demand_score,
            risk_score=risk_score,
            url=url,
            tags=tags,
        )
        out.append(opp)

    return out


# ======================================================
# Radar scan
# ======================================================

async def run_radar_scan() -> List[Opportunity]:
    """Pull hot festival + boxing events from your Ticketmaster watchlists."""
    logger.info("Running radar scan (Ticketmaster watchlists)…")
    music, boxing = await asyncio.gather(
        fetch_tm_music_hot(),
        fetch_tm_boxing_hot(),
    )
    all_opps = music + boxing
    all_opps.sort(key=lambda o: o.trade_score, reverse=True)
    logger.info("Radar scan complete: %d opportunities.", len(all_opps))
    return all_opps


# ======================================================
# Background radar loop (NO JobQueue)
# ======================================================

async def radar_auto_loop(app):
    """
    Background task that runs forever, every RADAR_INTERVAL_SECONDS.
    Uses app.bot.send_message directly (no JobQueue).
    """
    global LAST_SCAN_TIME, LAST_SCAN_COUNT, ALERTED_EVENT_IDS, RADAR_LOOP_STARTED
    RADAR_LOOP_STARTED = True
    logger.info("Radar auto-loop started (interval=%ds).", RADAR_INTERVAL_SECONDS)

    while True:
        try:
            if not KNOWN_USERS:
                await asyncio.sleep(60)
                continue

            logger.info("Auto radar scan tick – scanning Ticketmaster watchlists…")
            opps = await run_radar_scan()
            LAST_SCAN_TIME = datetime.now(timezone.utc)
            LAST_SCAN_COUNT = len(opps)

            # Filter to “money maker” grade
            hot_opps = [o for o in opps if o.trade_score >= MONEY_MAKER_THRESHOLD]

            # Avoid re-alerting the same events in this process lifetime
            new_hot = [o for o in hot_opps if o.event_id not in ALERTED_EVENT_IDS]

            if not new_hot:
                logger.info("No NEW hot events above threshold this round.")
            else:
                # Cap alerts per scan
                new_hot = new_hot[:5]

                for o in new_hot:
                    ALERTED_EVENT_IDS.add(o.event_id)

                logger.info(
                    "Pushing %d new hot events to %d users.",
                    len(new_hot),
                    len(KNOWN_USERS),
                )

                for user_id in list(KNOWN_USERS):
                    for opp in new_hot:
                        tags_str = ""
                        if opp.tags:
                            tags_str = " | " + ", ".join(opp.tags)

                        price_line = "Price: unknown"
                        if opp.primary_min > 0 and opp.primary_max > 0:
                            price_line = (
                                f"Price: £{opp.primary_min:.0f}–£{opp.primary_max:.0f}"
                            )
                        elif opp.primary_min > 0:
                            price_line = f"From: £{opp.primary_min:.0f}"

                        lines = [
                            f"🚨 *Money-maker radar hit* ({opp.source})",
                            "",
                            f"*{opp.name}*",
                            f"{opp.venue} – {opp.city} – {opp.date_str}",
                            price_line,
                            (
                                f"Demand: {opp.demand_score:.1f} | "
                                f"Margin guess: {opp.margin_pct_guess:.1f}% | "
                                f"Risk: {opp.risk_score:.1f}"
                            ),
                            f"Trade score: *{opp.trade_score:.1f}*{tags_str}",
                        ]
                        if opp.url:
                            lines.append("")
                            lines.append(f"[View listing]({opp.url})")

                        text = "\n".join(lines)

                        try:
                            await app.bot.send_message(
                                chat_id=user_id,
                                text=text,
                                parse_mode="Markdown",
                                disable_web_page_preview=False,
                            )
                        except Exception as e:
                            logger.warning(
                                "Failed to send alert to %s: %s", user_id, e
                            )

        except Exception as e:
            logger.exception("Error in radar_auto_loop: %s", e)

        await asyncio.sleep(RADAR_INTERVAL_SECONDS)


async def on_startup(app):
    """Called once the Application is ready; start the radar loop + optional admin notify."""
    logger.info("on_startup() called – creating radar_auto_loop task.")
    app.create_task(radar_auto_loop(app))

    if ADMIN_CHAT_ID:
        try:
            text = (
                "🚀 SpectraSeat radar bot started.\n\n"
                f"Providers:\n"
                f"• Ticketmaster festivals: {'ON' if PROVIDER_CONFIG.get('tm_music', True) else 'OFF'} "
                f"({len(TM_MUSIC_WATCHLIST)} events)\n"
                f"• Ticketmaster boxing: {'ON' if PROVIDER_CONFIG.get('tm_boxing', True) else 'OFF'} "
                f"({len(TM_BOXING_WATCHLIST)} events)\n\n"
                f"Auto radar every {RADAR_INTERVAL_SECONDS // 60} min, "
                f"threshold trade_score ≥ {MONEY_MAKER_THRESHOLD:.0f}."
            )
            await app.bot.send_message(chat_id=int(ADMIN_CHAT_ID), text=text)
        except Exception as e:
            logger.warning("Failed to send startup notify to ADMIN_CHAT_ID: %s", e)


# ======================================================
# HUD builders
# ======================================================

def build_providers_status_lines() -> List[str]:
    tm_music_status = (
        "🎧 ON (festivals)" if PROVIDER_CONFIG.get("tm_music", True) else "⚠️ OFF"
    )
    tm_box_status = (
        "🥊 ON (boxing)" if PROVIDER_CONFIG.get("tm_boxing", True) else "⚠️ OFF"
    )

    return [
        f"• Ticketmaster (festivals): {tm_music_status} – {len(TM_MUSIC_WATCHLIST)} events",
        f"• Ticketmaster (boxing): {tm_box_status} – {len(TM_BOXING_WATCHLIST)} events",
    ]


def build_hud_main_text() -> str:
    if LAST_SCAN_TIME is None:
        last_scan_line = "Last scan: not run yet"
    else:
        when = LAST_SCAN_TIME.astimezone(timezone.utc).strftime("%d %b %Y %H:%M UTC")
        last_scan_line = f"Last scan: {when} – {LAST_SCAN_COUNT} events evaluated"

    radar_status = "✅ Running" if RADAR_LOOP_STARTED else "⚠️ Not started yet"

    heat = "🟢 calm"
    if LAST_SCAN_COUNT >= 200:
        heat = "🔥 heavy action"
    elif LAST_SCAN_COUNT >= 100:
        heat = "🟠 warm"

    providers_lines = build_providers_status_lines()

    lines = [
        "🧠 *SpectraSeat Radar HUD*",
        "",
        "📡 *System*",
        f"• Radar loop: {radar_status}",
        f"• Interval: {RADAR_INTERVAL_SECONDS // 60} min",
        f"• Money-maker threshold: trade_score ≥ {MONEY_MAKER_THRESHOLD:.0f}",
        "",
        "📈 *Market activity*",
        last_scan_line,
        f"Heat: {heat}",
        "",
        "👤 *Users*",
        f"• Known users: {len(KNOWN_USERS)}",
        f"• Unique hot events alerted (this run): {len(ALERTED_EVENT_IDS)}",
        "",
        "🎛 *Providers*",
        *providers_lines,
        "",
        "Use the buttons below to refresh, see hot events, or trigger a scan.",
    ]
    return "\n".join(lines)


def build_hud_providers_text() -> str:
    providers_lines = build_providers_status_lines()
    lines = [
        "🎛 *Provider Control*",
        "",
        *providers_lines,
        "",
        "Tap buttons to toggle providers on/off.\n\n"
        "_Note: Providers use Ticketmaster web pages only – no API keys required._",
    ]
    return "\n".join(lines)


def build_hud_hot_text(opps: List[Opportunity]) -> str:
    if not opps:
        return "🔥 *Hot Events*\n\nNo opportunities found right now. Try /scan later."

    top = opps[:7]
    lines = ["🔥 *Hot Events Snapshot*", ""]
    for opp in top:
        tags_str = ""
        if opp.tags:
            tags_str = " | " + ", ".join(opp.tags)

        price_line = "Price: unknown"
        if opp.primary_min > 0 and opp.primary_max > 0:
            price_line = f"Price: £{opp.primary_min:.0f}–£{opp.primary_max:.0f}"
        elif opp.primary_min > 0:
            price_line = f"From: £{opp.primary_min:.0f}"

        lines.append(
            f"*{opp.name}* ({opp.source})\n"
            f"{opp.venue} – {opp.city} – {opp.date_str}\n"
            f"{price_line}\n"
            f"Demand: {opp.demand_score:.1f} | Margin guess: {opp.margin_pct_guess:.1f}% | "
            f"Risk: {opp.risk_score:.1f}\n"
            f"Trade score: *{opp.trade_score:.1f}*{tags_str}\n"
            f"{opp.url or ''}\n"
        )
    return "\n".join(lines)


def build_hud_main_keyboard() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(
        [
            [
                InlineKeyboardButton("📊 Dashboard", callback_data="hud_main"),
                InlineKeyboardButton("🔥 Hot Now", callback_data="hud_hot"),
            ],
            [
                InlineKeyboardButton("🎛 Providers", callback_data="hud_providers"),
                InlineKeyboardButton("♻️ Refresh", callback_data="hud_refresh"),
            ],
            [
                InlineKeyboardButton("📡 Force Scan", callback_data="hud_scan"),
            ],
        ]
    )


def build_hud_providers_keyboard() -> InlineKeyboardMarkup:
    def label(flag: bool, name: str) -> str:
        return f"{'✅' if flag else '❌'} {name}"

    return InlineKeyboardMarkup(
        [
            [
                InlineKeyboardButton(
                    label(PROVIDER_CONFIG.get("tm_music", True), "TM Festivals"),
                    callback_data="hud_toggle_tm_music",
                ),
            ],
            [
                InlineKeyboardButton(
                    label(PROVIDER_CONFIG.get("tm_boxing", True), "TM Boxing"),
                    callback_data="hud_toggle_tm_boxing",
                ),
            ],
            [
                InlineKeyboardButton("⬅️ Back", callback_data="hud_main"),
            ],
        ]
    )


# ======================================================
# Commands
# ======================================================

async def cmd_start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    KNOWN_USERS.add(user_id)
    logger.info("User %s called /start. KNOWN_USERS=%d", user_id, len(KNOWN_USERS))

    text = (
        "✅ SpectraSeat radar online.\n\n"
        "I automatically scan your configured Ticketmaster *festival* and *boxing* events "
        "for money-making opportunities.\n\n"
        "Every few minutes I:\n"
        "• Scrape Ticketmaster event pages (no API keys)\n"
        "• Estimate price bands and score events for demand / margin / risk\n"
        "• DM you when something crosses the money-maker threshold.\n\n"
        "Commands:\n"
        "• /hud – full radar HUD (dashboard + buttons)\n"
        "• /status – quick status of last scan\n"
        "• /scan – force a manual radar scan now\n"
        "• /ping – simple health check\n"
        "• /ukhot – shortcut to /scan\n"
    )
    await update.message.reply_text(text, parse_mode="Markdown")


async def cmd_ping(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text("🏓 Pong – radar is alive.")


async def cmd_status(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    KNOWN_USERS.add(user_id)

    if LAST_SCAN_TIME is None:
        await update.message.reply_text(
            "I haven’t completed a radar scan yet. Use /scan to trigger one."
        )
        return

    when = LAST_SCAN_TIME.astimezone(timezone.utc).strftime("%d %b %Y %H:%M UTC")
    msg = (
        f"📊 Last radar scan: {when}\n"
        f"Events evaluated: {LAST_SCAN_COUNT}\n"
        f"Alerted events this session: {len(ALERTED_EVENT_IDS)}\n"
        f"Known users: {len(KNOWN_USERS)}"
    )
    await update.message.reply_text(msg)


async def cmd_scan(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Manual radar scan for when you want an instant snapshot."""
    user_id = update.effective_user.id
    KNOWN_USERS.add(user_id)
    logger.info("User %s requested manual /scan", user_id)

    msg = await update.message.reply_text("📡 Running radar scan now…")

    opps = await run_radar_scan()
    if not opps:
        await msg.edit_text(
            "No opportunities found right now.\n\n"
            "If this seems wrong, check that the Ticketmaster URLs in the watchlists "
            "still point to active events."
        )
        return

    text = build_hud_hot_text(opps)
    await msg.edit_text(text, parse_mode="Markdown", disable_web_page_preview=False)


async def cmd_hud(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Send the main HUD dashboard with buttons."""
    user_id = update.effective_user.id
    KNOWN_USERS.add(user_id)

    text = build_hud_main_text()
    keyboard = build_hud_main_keyboard()
    await update.message.reply_text(
        text,
        parse_mode="Markdown",
        disable_web_page_preview=True,
        reply_markup=keyboard,
    )


# ======================================================
# HUD callback handler
# ======================================================

async def hud_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    data = query.data

    if data in ("hud_main", "hud_refresh"):
        text = build_hud_main_text()
        keyboard = build_hud_main_keyboard()
        await query.edit_message_text(
            text=text,
            parse_mode="Markdown",
            disable_web_page_preview=True,
            reply_markup=keyboard,
        )
        return

    if data == "hud_providers":
        text = build_hud_providers_text()
        keyboard = build_hud_providers_keyboard()
        await query.edit_message_text(
            text=text,
            parse_mode="Markdown",
            disable_web_page_preview=True,
            reply_markup=keyboard,
        )
        return

    if data == "hud_hot":
        opps = await run_radar_scan()
        text = build_hud_hot_text(opps)
        keyboard = build_hud_main_keyboard()
        await query.edit_message_text(
            text=text,
            parse_mode="Markdown",
            disable_web_page_preview=False,
            reply_markup=keyboard,
        )
        return

    if data == "hud_scan":
        opps = await run_radar_scan()
        text = "📡 *Manual radar scan triggered from HUD*\n\n"
        text += build_hud_hot_text(opps)
        keyboard = build_hud_main_keyboard()
        await query.edit_message_text(
            text=text,
            parse_mode="Markdown",
            disable_web_page_preview=False,
            reply_markup=keyboard,
        )
        return

    # Toggles
    if data == "hud_toggle_tm_music":
        PROVIDER_CONFIG["tm_music"] = not PROVIDER_CONFIG.get("tm_music", True)
    elif data == "hud_toggle_tm_boxing":
        PROVIDER_CONFIG["tm_boxing"] = not PROVIDER_CONFIG.get("tm_boxing", True)

    if data.startswith("hud_toggle_"):
        text = build_hud_providers_text()
        keyboard = build_hud_providers_keyboard()
        await query.edit_message_text(
            text=text,
            parse_mode="Markdown",
            disable_web_page_preview=True,
            reply_markup=keyboard,
        )
        return


# ======================================================
# Main (POLLING, NO WEBHOOK, NO JOBQUEUE)
# ======================================================

def main() -> None:
    logger.info("Starting SpectraSeat autonomous UK radar bot (Ticketmaster watchlists)…")

    application = (
        ApplicationBuilder()
        .token(BOT_TOKEN)
        .post_init(on_startup)  # start radar loop after bot connects
        .build()
    )

    # Commands
    application.add_handler(CommandHandler("start", cmd_start))
    application.add_handler(CommandHandler("ping", cmd_ping))
    application.add_handler(CommandHandler("status", cmd_status))
    application.add_handler(CommandHandler("scan", cmd_scan))
    application.add_handler(CommandHandler("ukhot", cmd_scan))
    application.add_handler(CommandHandler("hud", cmd_hud))

    # HUD callback
    application.add_handler(CallbackQueryHandler(hud_callback, pattern=r"^hud_"))

    logger.info("Starting polling…")
    application.run_polling(allowed_updates=Update.ALL_TYPES)


if __name__ == "__main__":
    main()
