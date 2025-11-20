import os
from telegram.ext import ApplicationBuilder, CommandHandler

TOKEN = os.environ["BOT_TOKEN"]

async def start(update, context):
    await update.message.reply_text("Bot is live on Render (polling method)!")

def main():
    app = ApplicationBuilder().token(TOKEN).build()
    app.add_handler(CommandHandler("start", start))

    print("Bot is running with POLLING...")
    app.run_polling()

if __name__ == "__main__":
    main()
