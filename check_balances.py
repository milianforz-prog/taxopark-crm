"""Утренний отчёт по должникам в Telegram (запускается планировщиком Windows).

Запуск:
  python check_balances.py              — отправить отчёт в Telegram
  python check_balances.py --dry-run    — только вывести отчёт в консоль
  python check_balances.py --get-chat-id — узнать свой chat_id (сначала напишите боту;
                                           бот bot.py при этом должен быть остановлен)
"""

import json
import sys
import urllib.request

import fleet


def print_chat_ids(env):
    url = f"https://api.telegram.org/bot{env['TELEGRAM_BOT_TOKEN']}/getUpdates"
    with urllib.request.urlopen(url, timeout=30) as resp:
        updates = json.loads(resp.read().decode("utf-8")).get("result", [])
    if not updates:
        print("Нет сообщений. Напишите боту что-нибудь в Telegram и запустите снова.")
    for upd in updates:
        chat = (upd.get("message") or {}).get("chat", {})
        if chat:
            print(f"chat_id = {chat['id']}  ({chat.get('first_name') or chat.get('title', '')})")


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    env = fleet.load_env()
    if "--get-chat-id" in sys.argv:
        print_chat_ids(env)
        return
    threshold = fleet.threshold_from_env(env)
    try:
        parks = fleet.load_parks(env)
        text, kb = fleet.render_debtors(parks, "a", threshold, 0)
        text = "☀️ <b>Утренний отчёт</b>\n\n" + text
    except Exception as e:
        text, kb = f"❌ Ошибка проверки балансов: {fleet.esc(str(e))}", None
    print(text)
    if "--dry-run" in sys.argv:
        return
    tg = fleet.Telegram(env["TELEGRAM_BOT_TOKEN"])
    for chat_id in fleet.allowed_chats(env):
        tg.send(chat_id, text, kb)


if __name__ == "__main__":
    main()
