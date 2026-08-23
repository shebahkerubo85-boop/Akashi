import os
import logging
import time
from pathlib import Path
import user_memory

from openai import OpenAI
from dotenv import load_dotenv
from telegram import Update
from telegram.ext import (
    Application,
    CommandHandler,
    ContextTypes,
    MessageHandler,
    filters,
)

import subprocess
import sys
from pathlib import Path as _Path
subprocess.run([sys.executable, str(_Path(__file__).parent / "update_knowledge.py")], capture_output=True)

load_dotenv()

TELEGRAM_BOT_TOKEN = os.environ["TELEGRAM_BOT_TOKEN"]
GROQ_API_KEY = os.environ["GROQ_API_KEY"]

client = OpenAI(
    api_key=GROQ_API_KEY,
    base_url="https://api.groq.com/openai/v1",
)

SYSTEM_PROMPT_TEXT = (Path(__file__).parent / "system_prompt.md").read_text(encoding="utf-8")

conversations: dict[int, list] = {}
MAX_HISTORY = 20


def get_reply(user_id: int, message: str, display_name: str) -> str:
    history = conversations.setdefault(user_id, [])
    profile = user_memory.get_profile(user_id)
    context_parts = [SYSTEM_PROMPT_TEXT, f"[The person you are talking to is: {display_name}]"]
    if profile:
        context_parts.append(f"[Personality notes from how they text: {profile}]")
    messages = [{"role": "system", "content": p} for p in context_parts] + history + [{"role": "user", "content": message}]
    
    for attempt in range(3):
        try:
            response = client.chat.completions.create(
                model="openai/gpt-oss-120b",
                messages=messages,
                max_tokens=1024,
                temperature=0.8,
            )
            reply_text = response.choices[0].message.content
            conversations[user_id].append({"role": "user", "content": message})
            conversations[user_id].append({"role": "assistant", "content": reply_text})
            conversations[user_id] = conversations[user_id][-MAX_HISTORY:]
            return reply_text
        except Exception as e:
            if "rate_limit" in str(e).lower() or "429" in str(e):
                wait = 10 * (attempt + 1)
                logging.warning("Rate limited, retrying in %ds", wait)
                time.sleep(wait)
            else:
                raise
    return "Give me a sec — too many requests right now."


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

    if not mentioned and message.reply_to_message is None:
        return None

    if message.reply_to_message and message.reply_to_message.text:
        return message.reply_to_message.text

    return text.replace(f"@{bot_username}", "").strip() or text


async def handle_message(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    query = extract_query(update, context)
    if not query:
        return
    try:
        display_name = update.effective_user.first_name or update.effective_user.username or "Unknown"
        user_memory.remember(update.effective_user.id, display_name, query)
        reply = get_reply(update.effective_user.id, query, display_name)
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
