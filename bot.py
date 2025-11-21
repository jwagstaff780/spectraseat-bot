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

# ----------------------------------------------------
# Logging
# ----------------------------------------------------
logging.basicConfig(
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    level=logging.INFO,
)
logger = logging.getLogger(__name__)

# ----------------------------------------------------
# Environment (Render)
# ----------------------------------------------------
BOT_TOKEN = os.environ["BOT_TOKEN"]
PORT = int(os.environ.get("PORT", "8000"))
BASE_URL = os.environ.get("RENDER_EXTERNAL_URL", "").rstrip("/")

if not BASE_URL:
    raise RuntimeError(
        "RENDER_EXTERNAL_URL is missing. "
        "You MUST run this as a Web Service on Render."
    )

WEBHOOK_ROUTE = "webhook"
WEBHOOK_URL = f"{BASE_URL}/{WEBHOOK_ROUTE}"

# ----------------------------------------------------
# In-Memory "Database"
# ----------------------------------------------------
USER_ARTISTS: Dict[int, List[str]] = {}
USER_CITIES: Dict[int, List[str]] = {}
KNOWN_USERS: Set[int] = set()


# ----------------------------------------------------
# Helpers
# ----------------------------------------------------
def add_to_list(store: Dict[int, List[str]], user_id: int, value: str):
    """Add artist/city to user tracking list without duplicates."""
    value = value.strip()
    if not value:
        return

    current = store.get(user_id, [])
    if value.lower() not in [v.lower() for v in current]:
        current.append(value)
        store[user_id] = current


def format_watchlist(uid: int) -> str:
    artists = USER_ARTISTS.get(uid, [])
    cities = USER_CITIES.get(uid, [])

    if not artists and not cities:
        return (
            "You’re not tracking anything yet.\n\n"
            "Use:\n"
            "• /addartist Name\n"
            "• /addcity City\n\n"
            "to teach me what to scan."
        )

    text = "🎧 *Your Watchlist:*\n"
    if artists:
        text += "• *Artists:* " + ", ".join(artists) + "\n"
    if cities:
        text += "• *Cities:* " + ", ".join(cities)
    return text


# ----------------------------------------------------
# Commands
# ----------------------------------------------------
async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    uid = update.effective_user.id
    KNOWN_USERS.add(uid)

    msg = (
        "✅ *SpectraSeat AI Market Radar Activated*\n\n"
        "Your bot is live in webhook mode.\n\n"
        "Commands:\n"
        "• /addartist Name\n"
        "• /addcity City\n"
        "• /mywatch – show what you track\n"
        "• /hotdemo – demo market scores\n"
        "• /ping – check bot health"
    )
    await update.message.reply_text(msg, parse_mode="Markdown")


async def ping(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text("🏓 Bot is alive.")


async def addartist(update: Update, context: ContextTypes.DEFAULT_TYPE):
    uid = update.effective_user.id
    KNOWN_USERS.add(uid)

    if not context.args:
        await update.message.reply_text("Usage: /addartist Artist Name")
        return

    artist = " ".join(context.args)
    add_to_list(USER_ARTISTS, uid, artist)

    await update.message.reply_text(
        f"🎧 Added: *{artist}*", parse_mode="Markdown"
    )


async def addcity(update: Update, context: ContextTypes.DEFAULT_TYPE):
    uid = update.effective_user.id
    KNOWN_USERS.add(uid)

    if not context.args:
        await update.message.reply_text("Usage: /addcity City Name")
        return

    city = " ".join(context.args)
    add_to_list(USER_CITIES, uid, city)

    await update.message.reply_text(
        f"🏙 Added city: *{city}*", parse_mode="Markdown"
    )


async def mywatch(update: Update, context: ContextTypes.DEFAULT_TYPE):
    uid = update.effective_user.id
    KNOWN_USERS.add(uid)

    await update.message.reply_text(
        format_watchlist(uid), parse_mode="Markdown"
    )


# ----------------------------------------------------
# Demo Scoring (Safe, Stable)
# ----------------------------------------------------
async def hotdemo(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Demo scoring system using randomised events."""
    uid = update.effective_user.id
    KNOWN_USERS.add(uid)

    artists = USER_ARTISTS.get(uid, []) or ["Artist"]
    cities = USER_CITIES.get(uid, []) or ["City"]

    # Generate 3 demo "event scores"
    lines = ["🔥 *DEMO – Market Opportunity Scores*"]

    for i in range(3):
        artist = random.choice(artists)
        city = random.choice(cities)

        primary = random.choice([40, 50, 60, 80])
        resale = primary * random.choice([1.2, 1.4, 1.6])
        demand = random.randint(50, 95)
        risk = random.randint(5, 25)

        margin = round(((resale - primary) / primary) * 100, 1)
        score = demand + margin - risk

        lines.append(
            f"\n• *{artist}* – {city}\n"
            f"  Primary: £{primary}\n"
            f"  Resale Est: £{int(resale)}\n"
            f"  Demand: {demand} | Margin: {margin}% | Risk: {risk}\n"
            f"  → *Trade Score:* {round(score,1)}"
        )

    await update.message.reply_text("\n".join(lines), parse_mode="Markdown")


# ----------------------------------------------------
# Background Scanner (demo signals)
# ----------------------------------------------------
async def scan_markets(context: ContextTypes.DEFAULT_TYPE):
    if not KNOWN_USERS:
        return

    uid = random.choice(list(KNOWN_USERS))

    artists = USER_ARTISTS.get(uid, []) or ["Artist"]
    cities = USER_CITIES.get(uid, []) or ["City"]

    artist = random.choice(artists)
    city = random.choice(cities)

    msg = (
        "📡 *Radar Ping (demo)*\n\n"
        f"Possible movement detected:\n"
        f"• Artist: *{artist}*\n"
        f"• City: *{city}*\n\n"
        "_This is a functional test. Real data coming next._"
    )

    await context.bot.send_message(uid, msg, parse_mode="Markdown")


# ----------------------------------------------------
# Main – Webhook Mode (Render)
# ----------------------------------------------------
def main():
    logger.info("Starting SpectraSeat bot...")

    app = ApplicationBuilder().token(BOT_TOKEN).build()

    # Commands
    app.add_handler(CommandHandler("start", start))
    app.add_handler(CommandHandler("ping", ping))
    app.add_handler(CommandHandler("addartist", addartist))
    app.add_handler(CommandHandler("addcity", addcity))
    app.add_handler(CommandHandler("mywatch", mywatch))
    app.add_handler(CommandHandler("hotdemo", hotdemo))

    # Background scanner every 10 minutes
    app.job_queue.run_repeating(scan_markets, interval=600, first=60)

    # Webhook setup
    logger.info(f"Setting webhook → {WEBHOOK_URL}")
    app.run_webhook(
        listen="0.0.0.0",
        port=PORT,
        url_path=WEBHOOK_ROUTE,
        webhook_url=WEBHOOK_URL,
    )


if __name__ == "__main__":
    main()
