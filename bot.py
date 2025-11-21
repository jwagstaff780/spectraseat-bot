import os
import logging
import asyncio
import random
from typing import Dict, List, Set

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
BOT_TOKEN = os.environ["BOT_TOKEN"]  # set in Render
PORT = int(os.environ.get("PORT", "8000"))
BASE_URL = os.environ.get("RENDER_EXTERNAL_URL", "").rstrip("/")

if not BASE_URL:
    raise RuntimeError(
        "RENDER_EXTERNAL_URL is not set. "
        "Make sure this is running as a Web Service on Render."
    )

WEBHOOK_ROUTE = "webhook"
WEBHOOK_URL = f"{BASE_URL}/{WEBHOOK_ROUTE}"

# Optional external API keys (we'll wire these up later)
TICKETMASTER_API_KEY = os.environ.get("TICKETMASTER_API_KEY")  # optional
SKIDDLE_API_KEY = os.environ.get("SKIDDLE_API_KEY")  # optional

# ---------- In-memory “DB” ----------
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


# ---------- Simple “opportunity” model ----------
class Opportunity:
    """
    Simple model for a trade idea.
    Later we'll fill this with real data from APIs.
    """

    def __init__(
        self,
        name: str,
        city: str,
        primary_price: float,
        resale_price: float,
        demand_score: float,
        risk_score: float,
        source: str = "demo",
    ):
        self.name = name
        self.city = city
        self.primary_price = primary_price
        self.resale_price = resale_price
        self.demand_score = demand_score
        self.risk_score = risk_score
        self.source = source

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
        "• /radar – run a live scan (demo + real APIs if keys set)\n"
        "• /ping – health check\n\n"
        "Right now this is a *demo brain* with fake opportunities.\n"
        "Next step is wiring in real ticket + social data."
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
                source="demo",
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
            f"  → Trade score: *{ev.trade_score:.1f}*  _(source: {ev.source})_"
        )

    await update.message.reply_text("\n".join(lines), parse_mode="Markdown")


# ---------- Ticket source stubs ----------
async def fetch_from_ticketmaster(
    artists: List[str],
    cities: List[str],
) -> List[Opportunity]:
    """
    Placeholder for the real Ticketmaster integration.

    Once you set TICKETMASTER_API_KEY in Render,
    this function can call their official API and build real opportunities.
    """
    if not TICKETMASTER_API_KEY:
        logger.info("No TICKETMASTER_API_KEY set – skipping Ticketmaster.")
        return []

    # TODO: implement real call to Ticketmaster's documented API.
    # For now we just log and return an empty list to stay safe.
    logger.info("Ticketmaster integration not implemented yet.")
    return []


async def fetch_from_skiddle(
    artists: List[str],
    cities: List[str],
) -> List[Opportunity]:
    """
    Placeholder for Skiddle (UK events) using their official API.

    Requires SKIDDLE_API_KEY in Render.
    """
    if not SKIDDLE_API_KEY:
        logger.info("No SKIDDLE_API_KEY set – skipping Skiddle.")
        return []

    logger.info("Skiddle integration not implemented yet.")
    return []


async def build_demo_opportunities(
    artists: List[str],
    cities: List[str],
) -> List[Opportunity]:
    """
    Demo generator – gives you something to look at even without API keys.
    """
    if not artists:
        artists = ["Central Cee", "Esdee Kid", "Meekz", "Booter Bee"]
    if not cities:
        cities = ["London", "Manchester", "Leeds"]

    out: List[Opportunity] = []
    for _ in range(4):
        artist = random.choice(artists)
        city = random.choice(cities)
        primary_price = random.choice([35.0, 50.0, 70.0, 90.0])
        resale_price = primary_price * random.choice([1.1, 1.2, 1.4, 1.7])
        demand_score = random.uniform(50, 95)
        risk_score = random.uniform(10, 35)
        out.append(
            Opportunity(
                name=f"{artist} – {city} special",
                city=city,
                primary_price=primary_price,
                resale_price=resale_price,
                demand_score=demand_score,
                risk_score=risk_score,
                source="demo-radar",
            )
        )
    return out


async def run_radar_scan(user_id: int) -> List[Opportunity]:
    artists = USER_ARTISTS.get(user_id, [])
    cities = USER_CITIES.get(user_id, [])

    # In parallel: ask real sources (if keys) + demo generator
    tasks = [
        fetch_from_ticketmaster(artists, cities),
        fetch_from_skiddle(artists, cities),
        build_demo_opportunities(artists, cities),
    ]
    all_lists = await asyncio.gather(*tasks, return_exceptions=False)

    opportunities: List[Opportunity] = []
    for lst in all_lists:
        opportunities.extend(lst)

    opportunities.sort(key=lambda e: e.trade_score, reverse=True)
    return opportunities


# ---------- /radar command ----------
async def radar(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    KNOWN_USERS.add(user_id)

    await update.message.reply_text(
        "📡 Running radar scan…\n\n"
        "_Note: if you haven't added API keys yet, this will mainly use "
        "demo data shaped like real trades._",
        parse_mode="Markdown",
    )

    opportunities = await run_radar_scan(user_id)

    if not opportunities:
        await update.message.reply_text(
            "No opportunities found yet. Once we wire in real ticket APIs, "
            "this will light up.",
        )
        return

    top = opportunities[:5]
    lines = ["🔥 *Radar snapshot*"]
    for ev in top:
        lines.append(
            f"\n• *{ev.name}* – {ev.city}\n"
            f"  Primary: £{ev.primary_price:.2f} | Resale: ~£{ev.resale_price:.2f}\n"
            f"  Demand: {ev.demand_score:.1f} | Margin: {ev.margin_score:.1f}% | "
            f"Risk: {ev.risk_score:.1f}\n"
            f"  → Trade score: *{ev.trade_score:.1f}*  _(source: {ev.source})_"
        )

    await update.message.reply_text("\n".join(lines), parse_mode="Markdown")


# ---------- Main / webhook setup ----------
def main() -> None:
    app = ApplicationBuilder().token(BOT_TOKEN).build()

    # Commands
    app.add_handler(CommandHandler("start", start))
    app.add_handler(CommandHandler("ping", ping))
    app.add_handler(CommandHandler("addartist", addartist))
    app.add_handler(CommandHandler("addcity", addcity))
    app.add_handler(CommandHandler("mywatch", mywatch))
    app.add_handler(CommandHandler("hotdemo", hotdemo))
    app.add_handler(CommandHandler("radar", radar))

    # Webhook (Render)
    logger.info("Setting webhook to %s", WEBHOOK_URL)
    app.run_webhook(
        listen="0.0.0.0",
        port=PORT,
        url_path=BOT_TOKEN,
        webhook_url=f"{WEBHOOK_URL}/{BOT_TOKEN}",
    )


if __name__ == "__main__":
    main()
