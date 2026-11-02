"""Telegram-бот таксопарка: должники, поиск водителя, сводка, выбор парка — всё кнопками.

Запуск: python bot.py (работает постоянно, в автозапуске через планировщик Windows).
"""

import json
import sys
import time
import traceback
from datetime import datetime

import fleet

STATE_FILE = fleet.BASE_DIR / "bot_state.json"

BTN_DEBTORS = "💸 Должники"
BTN_SUMMARY = "📊 Сводка"
BTN_SEARCH = "🔍 Найти водителя"
BTN_PARK = "🏢 Выбрать парк"

MAIN_KB = {
    "keyboard": [[{"text": BTN_DEBTORS}, {"text": BTN_SUMMARY}],
                 [{"text": BTN_SEARCH}, {"text": BTN_PARK}]],
    "resize_keyboard": True,
    "is_persistent": True,
}


def log(msg):
    line = f"{datetime.now():%d.%m %H:%M:%S} {msg}"
    print(line, flush=True)
    with open(fleet.BASE_DIR / "bot.log", "a", encoding="utf-8") as f:
        f.write(line + "\n")


class Bot:
    def __init__(self):
        self.env = fleet.load_env()
        self.tg = fleet.Telegram(self.env["TELEGRAM_BOT_TOKEN"])
        self.allowed = fleet.allowed_chats(self.env)
        self.threshold = fleet.threshold_from_env(self.env)
        self.parks = fleet.load_parks(self.env)
        self.parks_mtime = self._parks_mtime()
        self.state = self._load_state()
        self.pending = {}  # chat_id -> "search" | "threshold"

    # ---------- состояние ----------

    def _load_state(self):
        try:
            return json.loads(STATE_FILE.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}

    def _save_state(self):
        STATE_FILE.write_text(json.dumps(self.state, ensure_ascii=False), encoding="utf-8")

    def sel(self, chat_id):
        return self.state.get(str(chat_id), {}).get("park", "a")

    def _parks_mtime(self):
        path = fleet.BASE_DIR / "parks.json"
        return path.stat().st_mtime if path.exists() else 0

    def reload_parks_if_changed(self):
        mtime = self._parks_mtime()
        if mtime != self.parks_mtime:
            names = {p["park_id"]: p.get("name") for p in self.parks}
            self.parks = fleet.load_parks(self.env)
            for p in self.parks:
                p["name"] = p.get("name") or names.get(p["park_id"], "")
            self.parks_mtime = mtime
            log(f"parks.json перечитан: {len(self.parks)} парк(ов)")

    # ---------- обработка ----------

    def handle(self, update):
        self.reload_parks_if_changed()
        if "callback_query" in update:
            self.on_callback(update["callback_query"])
        elif "message" in update:
            self.on_message(update["message"])

    def on_message(self, msg):
        chat_id = msg["chat"]["id"]
        text = (msg.get("text") or "").strip()
        if str(chat_id) not in self.allowed:
            self.tg.send(chat_id, f"⛔ Нет доступа.\nВаш ID: <code>{chat_id}</code> — передайте его администратору.")
            log(f"отказ в доступе: {chat_id}")
            return
        if not text:
            return
        pending = self.pending.pop(chat_id, None)

        if text in ("/start", "/menu", "меню", "Меню"):
            self.tg.send(chat_id,
                         "👋 <b>Бот таксопарка</b>\n\n"
                         f"{BTN_DEBTORS} — водители с минусом\n"
                         f"{BTN_SUMMARY} — балансы и кто на линии\n"
                         f"{BTN_SEARCH} — карточка по фамилии или телефону\n"
                         f"{BTN_PARK} — один парк или все сразу\n\n"
                         f"Каждое утро в 9:00 пришлю список должников от {fleet.money(-self.threshold)}.",
                         reply_kb=MAIN_KB)
            return
        sel = self.sel(chat_id)
        self.typing(chat_id)
        if text == BTN_DEBTORS:
            self.tg.send(chat_id, *fleet.render_debtors(self.parks, sel, self.threshold, 0))
        elif text == BTN_SUMMARY:
            self.tg.send(chat_id, *fleet.render_summary(self.parks, sel, self.threshold))
        elif text == BTN_PARK:
            self.tg.send(chat_id, *fleet.render_parks(self.parks, sel))
        elif text == BTN_SEARCH:
            self.pending[chat_id] = "search"
            self.tg.send(chat_id, "🔍 Напишите <b>фамилию</b>, имя или последние цифры <b>телефона</b>:")
        elif pending == "threshold":
            digits = "".join(ch for ch in text if ch.isdigit())
            if not digits:
                self.pending[chat_id] = "threshold"
                self.tg.send(chat_id, "Напишите сумму числом, например <b>7000</b>:")
            else:
                self.tg.send(chat_id, *fleet.render_debtors(self.parks, sel, int(digits), 0))
        else:
            # любой другой текст — поиск водителя
            self.tg.send(chat_id, *fleet.render_search(self.parks, sel, text))

    def on_callback(self, cq):
        chat_id = cq["message"]["chat"]["id"]
        message_id = cq["message"]["message_id"]
        data = cq.get("data", "")
        if str(chat_id) not in self.allowed:
            self.answer(cq, "⛔ Нет доступа")
            return
        kind, _, rest = data.partition("|")
        args = rest.split("|")

        if kind == "N":
            self.answer(cq)
        elif kind in ("L", "R"):  # список должников / обновить
            sel, thr, page = args[0], int(args[1]), int(args[2])
            self.answer(cq, "🔄 Обновляю…" if kind == "R" else "")
            text, kb = fleet.render_debtors(self.parks, sel, thr, page, force=kind == "R")
            self.tg.edit(chat_id, message_id, text, kb)
        elif kind == "D":  # карточка из списка
            park_idx, driver_id, sel, thr, page = int(args[0]), args[1], args[2], args[3], args[4]
            self.answer(cq)
            text, kb = fleet.render_card(self.parks, park_idx, driver_id, back=f"L|{sel}|{thr}|{page}")
            self.tg.edit(chat_id, message_id, text, kb)
        elif kind in ("C", "F"):  # карточка из поиска / обновить карточку
            park_idx, driver_id = int(args[0]), args[1]
            back = "|".join(args[2:]) or None
            self.answer(cq, "🔄 Обновляю…" if kind == "F" else "")
            text, kb = fleet.render_card(self.parks, park_idx, driver_id, back=back, force=kind == "F")
            self.tg.edit(chat_id, message_id, text, kb)
        elif kind == "S":  # сводка
            self.answer(cq, "🔄 Обновляю…")
            text, kb = fleet.render_summary(self.parks, args[0], self.threshold, force=args[1:] == ["1"])
            self.tg.edit(chat_id, message_id, text, kb)
        elif kind == "P":  # выбор парка
            self.state.setdefault(str(chat_id), {})["park"] = args[0]
            self._save_state()
            title = fleet.park_title(self.parks, args[0])
            self.answer(cq, f"Выбран: {title}")
            text, kb = fleet.render_parks(self.parks, args[0])
            kb.append([fleet.btn("💸 Должники", f"L|{args[0]}|{self.threshold}|0"),
                       fleet.btn("📊 Сводка", f"S|{args[0]}")])
            self.tg.edit(chat_id, message_id, text, kb)
        elif kind == "T":  # свой порог
            self.answer(cq)
            self.pending[chat_id] = "threshold"
            self.tg.send(chat_id, "✏️ С какой суммы долга показывать? Напишите число, например <b>7000</b>:")
        else:
            self.answer(cq)

    def answer(self, cq, text=""):
        try:
            self.tg.call("answerCallbackQuery", callback_query_id=cq["id"], text=text)
        except Exception:
            pass

    def typing(self, chat_id):
        try:
            self.tg.call("sendChatAction", chat_id=chat_id, action="typing")
        except Exception:
            pass

    # ---------- цикл ----------

    def run(self):
        me = self.tg.call("getMe")
        self.tg.call("setMyCommands", commands=[{"command": "start", "description": "Показать меню"}])
        log(f"бот @{me['username']} запущен, парков: {len(self.parks)}, доступ: {', '.join(self.allowed)}")
        offset = None
        while True:
            try:
                params = {"timeout": 50, "allowed_updates": ["message", "callback_query"]}
                if offset is not None:
                    params["offset"] = offset
                updates = self.tg.call("getUpdates", http_timeout=70, **params)
            except Exception as e:
                log(f"ошибка связи с Telegram: {e}")
                time.sleep(5)
                continue
            for upd in updates:
                offset = upd["update_id"] + 1
                try:
                    self.handle(upd)
                except Exception as e:
                    log("ошибка обработки:\n" + traceback.format_exc())
                    chat = (upd.get("message") or upd.get("callback_query", {}).get("message") or {}).get("chat", {})
                    if chat.get("id"):
                        try:
                            self.tg.send(chat["id"], f"❌ Ошибка: {fleet.esc(str(e))[:500]}")
                        except Exception:
                            pass


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    Bot().run()
