# San — Telegram Bot for Sanin

Telegram bot with personality, knows everything about Sanin, learns user personalities.

## Setup

```bash
pip install -r requirements.txt
cp .env.example .env
# Edit .env with your tokens
python main.py
```

## Deploy (Oracle Cloud Free Tier)

```bash
sudo apt update && sudo apt install -y python3-pip screen git
git clone https://github.com/shebahkerubo85-boop/Akashi.git
cd Akashi
pip3 install --break-system-packages -r requirements.txt
nano .env  # add TELEGRAM_BOT_TOKEN and GROQ_API_KEY
screen -S san
python3 main.py
# Ctrl+A+D to detach
```

## Environment Variables

- `TELEGRAM_BOT_TOKEN` — from @BotFather
- `GROQ_API_KEY` — from console.groq.com
