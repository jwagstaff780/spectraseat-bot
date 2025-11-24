import os, re, asyncio, logging
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import List, Optional, Set

import httpx
from telegram import Update, InlineKeyboardMarkup, InlineKeyboardButton
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

BOT_TOKEN = os.environ.get("BOT_TOKEN", "dummy")
ADMIN_CHAT_ID = os.environ.get("ADMIN_CHAT_ID")  # optional

# Radar tuning
MONEY_MAKER_THRESHOLD = 70.0        # trade_score threshold
RADAR_INTERVAL_SECONDS = 300        # 5 minutes

# ======================================================
# In-memory state
# ======================================================

KNOWN_USERS: Set[int] = set()
ALERTED_EVENT_IDS: Set[str] = set()
LAST_SCAN_TIME: Optional[datetime] = None
LAST_SCAN_COUNT: int = 0
RADAR_LOOP_STARTED: bool = False


# ======================================================
# Models
# ======================================================

@dataclass
class WatchItem:
    url: str
    label: str
    city: str
    venue: str
    kind: str   # "festival" or "boxing"
    tags: List[str]


@dataclass
class Opportunity:
    event_id: str
    name: str
    city: str
    venue: str
    date_str: str
    source: str
    primary_min: float
    primary_max: float
    demand_score: float
    risk_score: float
    url: Optional[str] = None
    tags: Optional[List[str]] = None

    @property
    def margin_pct_guess(self) -> float:
        """Very rough proxy for potential % margin."""
        if self.primary_min <= 0:
            base = 8.0
        else:
            base = 10.0

        cheap_boost = 10.0 if 0 < self.primary_min <= 80 else 0.0
        demand_boost = max(0.0, self.demand_score - 50) * 0.35
        return max(0.0, base + cheap_boost + demand_boost)

    @property
    def trade_score(self) -> float:
        # Higher is better. We alert if this crosses MONEY_MAKER_THRESHOLD.
        return self.demand_score + self.margin_pct_guess - self.risk_score


# ======================================================
# Watchlists – REAL 2026 EVENTS
# (You can add/remove URLs here later)
# ======================================================

TM_FESTIVAL_WATCHLIST: List[WatchItem] = [
    WatchItem(
        url="https://www.ticketmaster.co.uk/rockstar-energy-presents-parklife-2026-tickets/artist/1061343",
        label="Parklife 2026 – Weekend – Manchester",
        city="Manchester",
        venue="Heaton Park",
        kind="festival",
        tags=["festival", "parklife"],
    ),
    WatchItem(
        url="https://www.ticketmaster.co.uk/rockstar-energy-presents-creamfields-2026-tickets/artist/29232",
        label="Creamfields 2026 – Daresbury",
        city="Daresbury",
        venue="Creamfields site",
        kind="festival",
        tags=["festival", "creamfields", "dance"],
    ),
    WatchItem(
        url="https://www.ticketmaster.co.uk/reading-festival-2026-weekend-reading-27-08-2026/event/3700630CD3F54A72",
        label="Reading Festival 2026 – Weekend",
        city="Reading",
        venue="Richfield Avenue",
        kind="festival",
        tags=["festival", "reading"],
    ),
    WatchItem(
        url="https://www.ticketmaster.co.uk/rockstar-energy-presents-leeds-2026-tickets/artist/35438",
        label="Leeds Festival 2026 – Weekend",
        city="Leeds",
        venue="Bramham Park",
        kind="festival",
        tags=["festival", "leeds"],
    ),
]

TM_BOXING_WATCHLIST: List[WatchItem] = [
    WatchItem(
        url="https://www.ticketmaster.co.uk/itauma-vs-franklin-the-magnificent-seven-manchester-24-01-2026/event/37006354CB0A846E",
        label="Itauma vs Franklin – The Magnificent Seven",
        city="Manchester",
        venue="Co-op Live",
        kind="boxing",
        tags=["boxing", "heavyweight"],
    ),
    WatchItem(
        url="https://www.ticketmaster.co.uk/a-night-of-professional-championship-boxing-fight-night-38-london-07-03-2026/event/1F006337B4387ED0",
        label="Fight Night 38 – Championship Boxing",
        city="London",
        venue="York Hall",
        kind="boxing",
        tags=["boxing", "championship"],
    ),
]


# ======================================================
# HTML fetching + parsing
# ======================================================

async def fetch_html(url: str) -> Optional[str]:
    """Fetch Ticketmaster HTML (no API key)."""
    headers = {
        "User-Agent": (
            "Mozilla/5.0 (compatible; SpectraSeatBot/1.0; +https://example.com/bot)"
        )
    }
    try:
        async with httpx.AsyncClient(
            timeout=15.0, headers=headers, follow_redirects=True
        ) as client:
            r = await client.get(url)
            r.raise_for_status()
            return r.text
    except Exception as e:
        logger.warning("Failed to fetch %s: %s", url, e)
        return None


DATE_REGEX = re.compile(
    r"(\d{1,2}\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+20\d{2})",
    re.IGNORECASE,
)
PRICE_REGEX = re.compile(r"£\s*([0-9]+(?:\.[0-9]{1,2})?)")


def extract_date(text: str) -> str:
    m = DATE_REGEX.search(text)
    if m:
        return m.group(1)
    return "Unknown date"


def extract_price_range(text: str) -> (float, float):
    prices = [float(p) for p in PRICE_REGEX.findall(text)]
    if not prices:
        return 0.0, 0.0
    return min(prices), max(prices)


def score_watch_item(
    item: WatchItem, price_min: float, price_max: float, date_str: str
) -> Opportunity:
    """Turn a WatchItem + scraped numbers into a scored Opportunity."""
    label_lower = item.label.lower()

    if item.kind == "festival":
        demand = 72.0
        risk = 22.0  # weather / line-up / travel risk

        if "creamfields" in label_lower:
            demand += 10
        if "parklife" in label_lower:
            demand += 8
        if "reading" in label_lower or "leeds" in label_lower:
            demand += 7

        tags = list(item.tags)
        if "weekend" in label_lower:
            tags.append("weekend-pass")

        source = "TM-Festival"

    else:  # boxing
        demand = 68.0
        risk = 30.0  # cancellations / injuries

        if "world" in label_lower or "title" in label_lower:
            demand += 7

        tags = list(item.tags)
        source = "TM-Boxing"

    return Opportunity(
        event_id=item.url,
        name=item.label,
        city=item.city,
        venue=item.venue,
        date_str=date_str,
        source=source,
        primary_min=price_min,
        primary_max=price_max,
        demand_score=demand,
        risk_score=risk,
        url=item.url,
        tags=tags,
    )


async def scan_watchlists() -> List[Opportunity]:
    """Fetch all watchlist URLs and score them."""
    logger.info(
        "Scanning Ticketmaster watchlists (%d festivals, %d boxing)...",
        len(TM_FESTIVAL_WATCHLIST),
        len(TM_BOXING_WATCHLIST),
    )

    opps: List[Opportunity] = []

    for item in TM_FESTIVAL_WATCHLIST + TM_BOXING_WATCHLIST:
        html = await fetch_html(item.url)
        if not html:
            continue

        date_str = extract_date(html)
        pmin, pmax = extract_price_range(html)
        opp = score_watch_item(item, pmin, pmax, date_str)
        opps.append(opp)

    opps.sort(key=lambda o: o.trade_score, reverse=True)
    logger.info("Watchlist scan produced %d opportunities.", len(opps))
    return opps


# ======================================================
# Background radar loop (no JobQueue, no webhooks)
# ======================================================

async def radar_auto_loop(app):
    """Runs forever, scanning watchlists every RADAR_INTERVAL_SECONDS."""
    global LAST_SCAN_TIME, LAST_SCAN_COUNT, RADAR_LOOP_STARTED, ALERTED_EVENT_IDS

    RADAR_LOOP_STARTED = True
    logger.info("Radar auto-loop running every %d seconds.", RADAR_INTERVAL_SECONDS)

    while True:
        try:
            if not KNOWN_USERS:
                # Nobody has done /start yet; chill.
                await asyncio.sleep(60)
                continue

            opps = await scan_watchlists()
            LAST_SCAN_TIME = datetime.now(timezone.utc)
            LAST_SCAN_COUNT = len(opps)

            hot = [o for o in opps if o.trade_score >= MONEY_MAKER_THRESHOLD]
            new_hot = [o for o in hot if o.event_id not in ALERTED_EVENT_IDS]

            for o in new_hot:
                ALERTED_EVENT_IDS.add(o.event_id)

            if not new_hot:
                logger.info("No NEW hot opportunities this round.")
            else:
                for user_id in list(KNOWN_USERS):
                    for opp in new_hot[:5]:
                        await send_opp(app, user_id, opp)

        except Exception as e:
            logger.exception("Error in radar_auto_loop: %s", e)

        await asyncio.sleep(RADAR_INTERVAL_SECONDS)


async def send_opp(app, chat_id: int, opp: Opportunity):
    """Push one opportunity to a user."""
    price_line = "Price: unknown"
    if opp.primary_min > 0 and opp.primary_max > 0:
        price_line = f"Price: £{opp.primary_min:.0f}–£{opp.primary_max:.0f}"
    elif opp.primary_min > 0:
        price_line = f"From: £{opp.primary_min:.0f}"

    tags_str = ""
    if opp.tags:
        tags_str = " | " + ", ".join(opp.tags)

    lines = [
        "🚨 Money-maker radar hit",
        f"Source: {opp.source}",
        "",
        opp.name,
        f"{opp.venue} – {opp.city} – {opp.date_str}",
        price_line,
        f"Demand score: {opp.demand_score:.1f}",
        f"Margin guess: {opp.margin_pct_guess:.1f}%",
        f"Risk score: {opp.risk_score:.1f}",
        f"Trade score: {opp.trade_score:.1f}{tags_str}",
    ]
    if opp.url:
        lines.append("")
        lines.append(f"Listing: {opp.url}")

    text = "\n".join(lines)

    try:
        # Plain text (NO Markdown) so we avoid parse-entity errors.
        await app.bot.send_message(
            chat_id=chat_id,
            text=text,
            disable_web_page_preview=False,
        )
    except Exception as e:
        logger.warning("Failed to send opp to %s: %s", chat_id, e)


# ======================================================
# HUD text + buttons
# ======================================================

def hud_text() -> str:
    if LAST_SCAN_TIME:
        when = LAST_SCAN_TIME.astimezone(timezone.utc).strftime("%d %b %Y %H:%M UTC")
        last_line = f"Last scan: {when} ({LAST_SCAN_COUNT} opportunities checked)"
    else:
        last_line = "Last scan: not run yet."

    radar_status = "running" if RADAR_LOOP_STARTED else "not started"

    lines = [
        "🧠 SpectraSeat Radar HUD",
        "",
        f"Radar loop: {radar_status}",
        f"Interval: {RADAR_INTERVAL_SECONDS // 60} minutes",
        f"Threshold trade_score: {MONEY_MAKER_THRESHOLD:.0f}",
        "",
        "Providers:",
        f"- Ticketmaster festivals: {len(TM_FESTIVAL_WATCHLIST)} watch URLs",
        f"- Ticketmaster boxing: {len(TM_BOXING_WATCHLIST)} watch URLs",
        "",
        f"Known users: {len(KNOWN_USERS)}",
        f"Unique hot events alerted this run: {len(ALERTED_EVENT_IDS)}",
        "",
        last_line,
        "",
        "Use /scan for a fresh manual scan.",
    ]
    return "\n".join(lines)


def build_hud_keyboard() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(
        [
            [
                InlineKeyboardButton("Refresh HUD", callback_data="hud_refresh"),
                InlineKeyboardButton("Show hot now", callback_data="hud_hot"),
            ]
        ]
    )


# ======================================================
# Telegram setup / commands
# ======================================================

async def on_startup(app):
    logger.info("on_startup → starting radar loop task")
    app.create_task(radar_auto_loop(app))

    if ADMIN_CHAT_ID:
        try:
            await app.bot.send_message(
                chat_id=int(ADMIN_CHAT_ID),
                text="SpectraSeat radar bot started.",
            )
        except Exception as e:
            logger.warning("Failed to message ADMIN_CHAT_ID: %s", e)


async def cmd_start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    KNOWN_USERS.add(user_id)

    text = (
        "SpectraSeat radar online.\n\n"
        "I watch a curated list of big UK *festival* and *boxing* events on Ticketmaster "
        "and alert you when the numbers look like a potential money-maker.\n\n"
        "Commands:\n"
        "- /hud – radar dashboard\n"
        "- /status – last scan info\n"
        "- /scan – run a manual radar scan now\n"
        "- /ping – simple health check\n"
    )
    await update.message.reply_text(text)


async def cmd_ping(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text("Pong – bot is alive.")


async def cmd_status(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    KNOWN_USERS.add(user_id)
    await update.message.reply_text(hud_text())


async def cmd_scan(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    KNOWN_USERS.add(user_id)

    msg = await update.message.reply_text("Running radar scan now…")

    opps = await scan_watchlists()
    if not opps:
        await msg.edit_text(
            "No opportunities found right now (watchlists might be empty or pages blocked)."
        )
        return

    hot = [o for o in opps if o.trade_score >= MONEY_MAKER_THRESHOLD]
    if not hot:
        await msg.edit_text(
            "Scan complete. Watchlist events checked, but none crossed the money-maker threshold."
        )
        return

    lines = ["Hot snapshot:"]
    for opp in hot[:7]:
        price_line = "Price: unknown"
        if opp.primary_min > 0 and opp.primary_max > 0:
            price_line = f"Price: £{opp.primary_min:.0f}–£{opp.primary_max:.0f}"
        elif opp.primary_min > 0:
            price_line = f"From: £{opp.primary_min:.0f}"

        tags_str = ""
        if opp.tags:
            tags_str = " | " + ", ".join(opp.tags)

        lines.append(
            f"\n{opp.name} ({opp.source})\n"
            f"{opp.venue} – {opp.city} – {opp.date_str}\n"
            f"{price_line}\n"
            f"Trade score: {opp.trade_score:.1f}{tags_str}"
        )

    await msg.edit_text("\n".join(lines))


async def cmd_hud(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    KNOWN_USERS.add(user_id)
    await update.message.reply_text(hud_text(), reply_markup=build_hud_keyboard())


async def hud_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    data = query.data

    if data == "hud_refresh":
        await query.edit_message_text(hud_text(), reply_markup=build_hud_keyboard())
        return

    if data == "hud_hot":
        opps = await scan_watchlists()
        if not opps:
            await query.edit_message_text("No opportunities found on latest scan.")
            return

        hot = [o for o in opps if o.trade_score >= MONEY_MAKER_THRESHOLD]
        if not hot:
            await query.edit_message_text(
                "Scan complete. Watchlist events checked, but none crossed the money-maker threshold."
            )
            return

        lines = ["Hot snapshot:"]
        for opp in hot[:7]:
            price_line = "Price: unknown"
            if opp.primary_min > 0 and opp.primary_max > 0:
                price_line = f"Price: £{opp.primary_min:.0f}–£{opp.primary_max:.0f}"
            elif opp.primary_min > 0:
                price_line = f"From: £{opp.primary_min:.0f}"

            tags_str = ""
            if opp.tags:
                tags_str = " | " + ", ".join(opp.tags)

            lines.append(
                f"\n{opp.name} ({opp.source})\n"
                f"{opp.venue} – {opp.city} – {opp.date_str}\n"
                f"{price_line}\n"
                f"Trade score: {opp.trade_score:.1f}{tags_str}"
            )

        await query.edit_message_text(
            "\n".join(lines),
            reply_markup=build_hud_keyboard(),
        )


# ======================================================
# Main
# ======================================================

def main() -> None:
    if BOT_TOKEN == "dummy":
        print("BOT_TOKEN not set in env vars.")
        return

    app = (
        ApplicationBuilder()
        .token(BOT_TOKEN)
        .post_init(on_startup)
        .build()
    )

    app.add_handler(CommandHandler("start", cmd_start))
    app.add_handler(CommandHandler("ping", cmd_ping))
    app.add_handler(CommandHandler("status", cmd_status))
    app.add_handler(CommandHandler("scan", cmd_scan))
    app.add_handler(CommandHandler("ukhot", cmd_scan))  # shortcut
    app.add_handler(CommandHandler("hud", cmd_hud))
    app.add_handler(CallbackQueryHandler(hud_callback, pattern="^hud_"))

    logger.info("Starting polling…")
    app.run_polling(allowed_updates=Update.ALL_TYPES)


if __name__ == "__main__":
    main()
