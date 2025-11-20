import os
from telegram import Update
from telegram.ext import ApplicationBuilder, CommandHandler, ContextTypes

# Get settings from environment variables
TOKEN = os.environ["TOKEN"]          # your bot token (from Render env var)
PORT = int(os.environ.get("PORT", 8000))  # Render sets PORT automatically
WEBHOOK_PATH = "webhook"            # URL path for Telegram to call
WEBHOOK_URL = os.environ["WEBHOOK_URL"]   # full https URL to your app + /webhook


async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text("✅ Bot is online via Render (webhook).")


async def ping(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text("🏓 Pong!")


def main():
    app = ApplicationBuilder().token(TOKEN).build()

    app.add_handler(CommandHandler("start", start))
    app.add_handler(CommandHandler("ping", ping))

    # This sets the webhook with Telegram and starts a small web server on Render
    app.run_webhook(
        listen="0.0.0.0",
        port=PORT,
        url_path=WEBHOOK_PATH,
        webhook_url=WEBHOOK_URL,
    )


if __name__ == "__main__":
    main()
