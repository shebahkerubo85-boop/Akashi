import os
import logging
from pathlib import Path

import google.generativeai as genai
from dotenv import load_dotenv
from telegram import Update
from telegram.ext import (
    Application,
    CommandHandler,
    ContextTypes,
    MessageHandler,
    filters,
)

load_dotenv()

TELEGRAM_BOT_TOKEN = os.environ["TELEGRAM_BOT_TOKEN"]
GEMINI_API_KEY = os.environ["GEMINI_API_KEY"]

genai.configure(api_key=GEMINI_API_KEY)

SYSTEM_PROMPT_TEXT = (Path(__file__).parent / "system_prompt.md").read_text(encoding="utf-8")

model = genai.GenerativeModel(
    model_name="gemini-3.6-flash",
    system_instruction=SYSTEM_PROMPT_TEXT,
)

conversations: dict[int, list] = {}
MAX_HISTORY = 20


def get_reply(user_id: int, message: str) -> str:
    history = conversations.setdefault(user_id, [])
    chat = model.start_chat(history=history)
    response = chat.send_message(message)
    conversations[user_id] = chat.history[-MAX_HISTORY:]
    return response.text


async def start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    await update.message.reply_text(
        "Yo. Ask me anything about Sanin, or just talk."
    )


async def clear(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    conversations.pop(update.effective_user.id, None)
    await update.message.reply_text("Memory wiped. Who are you again?")


def extract_query(update: Update, context: ContextTypes.DEFAULT_TYPE) -> str | None:
    message = update.message
    if not message or not message.text:
        return None

    bot_username = context.bot.username
    text = message.text
    mentioned = bot_username and f"@{bot_username}" in text

    if message.chat.type == "private":
        return text

    # Group/channel: only act when tagged or when replying to someone
    if not mentioned and message.reply_to_message is None:
        return None

    # If replying to a message, answer THAT message (the original question)
    if message.reply_to_message and message.reply_to_message.text:
        return message.reply_to_message.text

    # Otherwise answer the text with the mention stripped out
    return text.replace(f"@{bot_username}", "").strip() or text


async def handle_message(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    query = extract_query(update, context)
    if not query:
        return
    try:
        reply = get_reply(update.effective_user.id, query)
        await update.message.reply_text(reply)
    except Exception:
        logging.exception("Error generating reply")
        await update.message.reply_text("Something broke on my end. Try again.")


def main() -> None:
    app = (
        Application.builder()
        .token(TELEGRAM_BOT_TOKEN)
        .connect_timeout(30)
        .read_timeout(30)
        .write_timeout(30)
        .build()
    )
    app.add_handler(CommandHandler("start", start))
    app.add_handler(CommandHandler("clear", clear))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_message))
    print("San is running...")
    app.run_polling()


if __name__ == "__main__":
    main()
