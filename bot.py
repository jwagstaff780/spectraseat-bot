import os
import logging
import random
from typing import Dict, List, Set

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
BOT_TOKEN = os.environ["BOT_TOKEN"]  # set in Render as env var
PORT = int(os.environ.get("PORT", "8000"))
BASE_URL = os.environ.get("RENDER_EXTERNAL_URL", "").rstrip("/")

if not BASE_URL:
    raise RuntimeError(
        "RENDER_EXTERNAL_URL is not set. "
        "Make sure this service is running as a Web Service on Render."
    )

WEBHOOK_ROUTE = "webhook"
WEBHOOK_URL = f"{BASE_URL}/{WEBHOOK_ROUTE}"

# ---------- In-memory “DB” (per process) ----------
# Later you can move this into a real database.
USER_ARTISTS: Dict[int, List[str]] = {}
USER_CITIES: Dict[int, List[str]] = {}
KNOWN_USERS: Set[int] = set()


# ---------- Helpers ----------
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
    Simple demo model.
    Later you plug in real data from ticket sites + socials.
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
        # First version: demand + margin − risk
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
    This uses fake data for now so you can see the behaviour.
    """
    user_id = update.effective_user.id
    KNOWN_USERS.add(user_id)

    artists = USER_ARTISTS.get(user_id, []) or ["Unknown Artist"]
    cities = USER_CITIES.get(user_id, []) or ["London"]

    # Build some fake opportunities
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

    # Sort by trade_score (highest first)
    fake_events.sort(key=lambda e: e.trade_score, reverse=True)

    lines = ["🔥 *Demo hot opportunities (fake data)*"]
    for ev in fake_events:
        lines.append(
            f"\n• *{ev.name}* – {ev.city}\n"
            f"  Primary: £{ev.primary_price:.2f} | Resale: ~£{ev.resale_price:.2f}\n"
            f"  Demand: {ev.demand_score:.1f} | "
            f"Margin: {ev.margin_score:.1f}% | "
            f"Risk: {ev.risk_score:.1f}\n"
            f"  → Trade score: *{ev.trade_score:.1f}*"
        )

    await update.message.reply_text("\n".join(lines), parse_mode="Markdown")


# ---------- Main / webhook ----------
def main() -> None:
    app = ApplicationBuilder().token(BOT_TOKEN).build()

    app.add_handler(CommandHandler("start", start))
    app.add_handler(CommandHandler("ping", ping))
    app.add_handler(CommandHandler("addartist", addartist))
    app.add_handler(CommandHandler("addcity", addcity))
    app.add_handler(CommandHandler("mywatch", mywatch))
    app.add_handler(CommandHandler("hotdemo", hotdemo))

    # Run as webhook on Render
    app.run_webhook(
        listen="0.0.0.0",
        port=PORT,
        url_path=WEBHOOK_ROUTE,
        webhook_url=WEBHOOK_URL,
    )


if __name__ == "__main__":
    main()
