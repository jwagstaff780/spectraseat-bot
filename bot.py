import os
import logging
from telegram import Update
from telegram.ext import ApplicationBuilder, CommandHandler, ContextTypes

# --- Logging (helps debug in Render logs) ---
logging.basicConfig(
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    level=logging.INFO,
)
logger = logging.getLogger(__name__)

# --- Config from environment ---
# Render: you will set BOT_TOKEN in Environment Variables.
TOKEN = os.environ["BOT_TOKEN"]  # Do NOT hardcode your token

# Render automatically sets these:
# PORT: the port your web service must listen on
# RENDER_EXTERNAL_URL: e.g. "https://spectraseat-bot.onrender.com"
PORT = int(os.environ.get("PORT", "8000"))
BASE_URL = os.environ.get("RENDER_EXTERNAL_URL")

if not BASE_URL:
    raise RuntimeError(
        "RENDER_EXTERNAL_URL is not set. "
        "Make sure this is deployed as a *Web Service* on Render."
    )

# Webhook path & full URL for Telegram to call
WEBHOOK_ROUTE = "webhook"  # URL path segment
WEBHOOK_URL = BASE_URL.rstrip("/") + f"/{WEBHOOK_ROUTE}"


# --- Handlers ---
async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text("✅ Bot is online via Render (webhook).")


async def ping(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text("🏓 Pong (webhook mode)!")


# --- Main ---
def main():
    logger.info("Starting bot with webhook...")
    logger.info("Using BASE_URL=%s", BASE_URL)
    logger.info("Using WEBHOOK_URL=%s", WEBHOOK_URL)
    logger.info("Listening on PORT=%s", PORT)

    app = ApplicationBuilder().token(TOKEN).build()

    # Commands
    app.add_handler(CommandHandler("start", start))
    app.add_handler(CommandHandler("ping", ping))

    # Start webhook server (aiohttp) and register webhook with Telegram
    app.run_webhook(
        listen="0.0.0.0",
        port=PORT,
        url_path=WEBHOOK_ROUTE,   # WITHOUT leading slash
        webhook_url=WEBHOOK_URL,  # Full https URL Telegram will call
    )


if __name__ == "__main__":
    main()
