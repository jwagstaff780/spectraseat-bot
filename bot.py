from telegram.ext import ApplicationBuilder, CommandHandler
import os

# Read your Telegram bot token from the Render env variable
TOKEN = os.environ["BOT_TOKEN"]


async def start(update, context):
    await update.message.reply_text("Bot is online!")


async def ping(update, context):
    await update.message.reply_text("Pong!")


def main():
    app = ApplicationBuilder().token(TOKEN).build()

    app.add_handler(CommandHandler("start", start))
    app.add_handler(CommandHandler("ping", ping))

    app.run_polling()


if __name__ == "__main__":
    main()
