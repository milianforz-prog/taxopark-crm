"""Telegram-бот для водителей: вход по номеру телефона, личный кабинет, покупка и отключение смены.

Запуск: python driver_bot.py (работает постоянно, как и bot.py).

Настройка (.env):
  DRIVER_BOT_TOKEN=токен отдельного бота от @BotFather
  SHIFT_MIN_DAYS=6           — через сколько дней можно отключить смену (по умолчанию 6)

Смена = «условие работы» водителя в Яндекс Про (work rule). Купить смену — перевести водителя
на условие-смену, отключить — вернуть на прежнее условие. Какие условия считаются сменами,
задаётся в parks.json у каждого парка (необязательно):
  "shift_rules": ["id условия", ...]   — если нет, сменами считаются условия со словом «смена» в названии
  "default_rule_id": "id условия"      — куда возвращать при отключении (если нет — на условие до покупки)
"""

import json
import sys
import time
import traceback
from datetime import datetime, timedelta, timezone

import fleet

STATE_FILE = fleet.BASE_DIR / "driver_bot_state.json"

BTN_CABINET = "👤 Личный кабинет"
BTN_SHIFT = "🕐 Смена"
BTN_LOGOUT = "🚪 Выйти"

MAIN_KB = {
    "keyboard": [[{"text": BTN_CABINET}, {"text": BTN_SHIFT}], [{"text": BTN_LOGOUT}]],
    "resize_keyboard": True,
    "is_persistent": True,
}
PHONE_KB = {
    "keyboard": [[{"text": "📱 Отправить номер телефона", "request_contact": True}]],
    "resize_keyboard": True,
    "one_time_keyboard": True,
}


def log(msg):
    line = f"{datetime.now():%d.%m %H:%M:%S} {msg}"
    print(line, flush=True)
    with open(fleet.BASE_DIR / "driver_bot.log", "a", encoding="utf-8") as f:
        f.write(line + "\n")


def now_utc():
    return datetime.now(timezone.utc)


def local(dt):
    return dt.astimezone().strftime("%d.%m.%Y %H:%M")


class DriverBot:
    def __init__(self):
        self.env = fleet.load_env()
        self.tg = fleet.Telegram(self.env["DRIVER_BOT_TOKEN"])
        self.min_days = int(self.env.get("SHIFT_MIN_DAYS", "6"))
        self.parks = fleet.load_parks(self.env)
        # уведомления сотрудникам — через основной бот, если он настроен
        token = self.env.get("TELEGRAM_BOT_TOKEN")
        self.staff_tg = fleet.Telegram(token) if token else None
        self.staff_chats = fleet.allowed_chats(self.env)
        self.state = self._load_state()
        self.state.setdefault("users", {})   # telegram user id -> {park_id, driver_id, phone}
        self.state.setdefault("shifts", {})  # driver id -> {park_id, rule_id, rule_name, started_at, prev_rule_id}

    # ---------- состояние ----------

    def _load_state(self):
        try:
            return json.loads(STATE_FILE.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}

    def _save_state(self):
        tmp = STATE_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.state, ensure_ascii=False, indent=1), encoding="utf-8")
        tmp.replace(STATE_FILE)

    # ---------- водитель ----------

    def park_by_id(self, park_id):
        return next((p for p in self.parks if p["park_id"] == park_id), None)

    def current_driver(self, user_id, force=False):
        """(парк, водитель) для вошедшего пользователя или (None, None)."""
        link = self.state["users"].get(str(user_id))
        if not link:
            return None, None
        park = self.park_by_id(link["park_id"])
        if not park:
            return None, None
        d = next((x for x in fleet.fetch_park(park, force) if x["id"] == link["driver_id"]), None)
        # водитель уволен или сменил номер — выходим из кабинета
        if not d or d["work_status"] == "fired" or fleet.phone_key(d["phone"]) != fleet.phone_key(link["phone"]):
            self.state["users"].pop(str(user_id), None)
            self._save_state()
            return None, None
        return park, d

    def shift_rules(self, park):
        """Условия работы парка, которые считаются сменами."""
        rules = [r for r in fleet.work_rules(park) if r.get("is_enabled", True)]
        ids = park.get("shift_rules")
        if ids:
            return [r for r in rules if r["id"] in ids]
        return [r for r in rules if "смен" in (r.get("name") or "").lower()]

    def rule_name(self, park, rule_id):
        return next((r.get("name") for r in fleet.work_rules(park) if r["id"] == rule_id), None) or "—"

    def shift_info(self, park, driver_id, rule_id):
        """Запись о смене, если водитель сейчас на условии-смене. Поставленную диспетчером смену
        бот видит впервые — считаем её начало с этого момента."""
        rec = self.state["shifts"].get(driver_id)
        shift_ids = {r["id"] for r in self.shift_rules(park)}
        if rule_id not in shift_ids:
            if rec:  # смену сняли вручную в парке
                self.state["shifts"].pop(driver_id, None)
                self._save_state()
            return None
        if not rec or rec.get("rule_id") != rule_id:
            rec = {"park_id": park["park_id"], "rule_id": rule_id, "rule_name": self.rule_name(park, rule_id),
                   "started_at": now_utc().isoformat(), "prev_rule_id": park.get("default_rule_id", "")}
            self.state["shifts"][driver_id] = rec
            self._save_state()
        return rec

    def unlock_at(self, rec):
        return datetime.fromisoformat(rec["started_at"]) + timedelta(days=self.min_days)

    # ---------- экраны ----------

    def render_cabinet(self, park, d):
        rule_id = (fleet.driver_profile_v2(park, d["id"]).get("account") or {}).get("work_rule_id", "")
        rec = self.shift_info(park, d["id"], rule_id)
        bal_icon = "🔴" if d["balance"] < 0 else "🟢"
        lines = [
            f"👤 <b>{fleet.esc(fleet.full_name(d, middle=True))}</b>",
            f"🏢 {fleet.esc(park.get('name', ''))}",
            "",
            f"{bal_icon} Баланс: <b>{fleet.money(d['balance'])}</b>",
            f"🚗 {fleet.esc(' · '.join(x for x in (d['car'], d['car_number']) if x)) or '—'}",
            f"📍 Сейчас: {fleet.CURRENT_STATUS.get(d['status'], '⚫ офлайн')}",
            f"📋 Условие работы: {fleet.esc(self.rule_name(park, rule_id))}",
            "",
        ]
        kb = []
        if rec:
            started = datetime.fromisoformat(rec["started_at"])
            days = (now_utc() - started).days
            unlock = self.unlock_at(rec)
            lines.append(f"🕐 <b>Смена активна</b>: {fleet.esc(rec['rule_name'])}")
            lines.append(f"📅 С {local(started)} · идёт {days + 1}-й день")
            if now_utc() >= unlock:
                lines.append("✅ Смену можно отключить")
            else:
                lines.append(f"🔒 Отключить можно с <b>{local(unlock)}</b>")
            kb.append([fleet.btn("⛔ Отключить смену", "X")])
        else:
            lines.append("🕐 Смена не подключена")
            kb.append([fleet.btn("🛒 Купить смену", "B")])
        kb.append([fleet.btn("🔄 Обновить", "R")])
        return "\n".join(lines), kb

    def render_shop(self, park, d):
        rules = self.shift_rules(park)
        if not rules:
            return "😔 В парке сейчас нет доступных смен. Обратитесь к диспетчеру.", [[fleet.btn("⬅️ Назад", "R")]]
        lines = ["🛒 <b>Выберите смену</b>", "",
                 f"⚠️ Отключить смену можно будет только через {self.min_days} дн. после покупки."]
        kb = [[fleet.btn(r.get("name") or "Смена", f"S|{r['id']}")] for r in rules]
        kb.append([fleet.btn("⬅️ Назад", "R")])
        return "\n".join(lines), kb

    # ---------- обработка ----------

    def handle(self, update):
        if "callback_query" in update:
            self.on_callback(update["callback_query"])
        elif "message" in update:
            self.on_message(update["message"])

    def ask_phone(self, chat_id):
        self.tg.send(chat_id,
                     "👋 <b>Здравствуйте!</b>\n\nЭто бот водителей таксопарка. Чтобы войти в личный кабинет, "
                     "нажмите кнопку ниже и отправьте свой номер телефона — тот, что указан в парке.",
                     reply_kb=PHONE_KB)

    def on_message(self, msg):
        chat_id = msg["chat"]["id"]
        user_id = msg.get("from", {}).get("id")
        if msg["chat"].get("type") != "private":
            return
        if "contact" in msg:
            self.on_contact(chat_id, user_id, msg["contact"])
            return
        text = (msg.get("text") or "").strip()
        park, d = self.current_driver(user_id)
        if not d:
            self.ask_phone(chat_id)
            return
        if text == BTN_LOGOUT:
            self.state["users"].pop(str(user_id), None)
            self._save_state()
            self.tg.send(chat_id, "👋 Вы вышли из кабинета.", reply_kb={"remove_keyboard": True})
            self.ask_phone(chat_id)
        elif text == BTN_SHIFT:
            self.tg.send(chat_id, *self.render_cabinet(park, d))
        else:  # /start, «Личный кабинет» и любой другой текст
            self.tg.send(chat_id, "Главное меню 👇", reply_kb=MAIN_KB)
            self.tg.send(chat_id, *self.render_cabinet(park, d))

    def on_contact(self, chat_id, user_id, contact):
        if contact.get("user_id") != user_id:
            self.tg.send(chat_id, "⛔ Отправьте <b>свой</b> номер кнопкой «📱 Отправить номер телефона».",
                         reply_kb=PHONE_KB)
            return
        phone = contact.get("phone_number", "")
        found = fleet.find_by_phone(self.parks, phone, force=True)
        if not found:
            log(f"вход не удался: {user_id} {phone}")
            self.tg.send(chat_id, f"😔 Номер <b>{fleet.esc(phone)}</b> не найден среди водителей парка.\n\n"
                                  "Проверьте, что в Telegram тот же номер, что в Яндекс Про, "
                                  "или обратитесь к диспетчеру.", reply_kb=PHONE_KB)
            return
        if len(found) > 1:  # один номер в нескольких парках — пусть выберет
            kb = [[fleet.btn(f"{fleet.full_name(d)} · {self.parks[i].get('name', '')}", f"P|{i}|{d['id']}")]
                  for i, d in found]
            self.state.setdefault("pending_phone", {})[str(user_id)] = phone
            self._save_state()
            self.tg.send(chat_id, "Ваш номер есть в нескольких парках. Выберите профиль:", kb)
            return
        idx, d = found[0]
        self.login(chat_id, user_id, self.parks[idx], d, phone)

    def login(self, chat_id, user_id, park, d, phone):
        self.state["users"][str(user_id)] = {"park_id": park["park_id"], "driver_id": d["id"], "phone": phone}
        self.state.get("pending_phone", {}).pop(str(user_id), None)
        self._save_state()
        log(f"вход: {user_id} → {fleet.full_name(d)} ({park.get('name', '')})")
        self.tg.send(chat_id, f"✅ Добро пожаловать, <b>{fleet.esc(d['first_name'] or fleet.full_name(d))}</b>!",
                     reply_kb=MAIN_KB)
        self.tg.send(chat_id, *self.render_cabinet(park, d))

    def on_callback(self, cq):
        chat_id = cq["message"]["chat"]["id"]
        message_id = cq["message"]["message_id"]
        user_id = cq["from"]["id"]
        kind, _, rest = cq.get("data", "").partition("|")
        args = rest.split("|")

        if kind == "P":  # выбор профиля при одном номере в нескольких парках
            phone = self.state.get("pending_phone", {}).get(str(user_id))
            idx = int(args[0])
            match = [d for i, d in fleet.find_by_phone(self.parks, phone or "") if i == idx and d["id"] == args[1]]
            self.answer(cq)
            if not match:
                self.ask_phone(chat_id)
                return
            self.login(chat_id, user_id, self.parks[idx], match[0], phone)
            return

        park, d = self.current_driver(user_id, force=kind == "R")
        if not d:
            self.answer(cq, "Войдите заново")
            self.ask_phone(chat_id)
            return

        if kind == "R":
            self.answer(cq, "🔄 Обновляю…")
            self.tg.edit(chat_id, message_id, *self.render_cabinet(park, d))
        elif kind == "B":
            self.answer(cq)
            self.tg.edit(chat_id, message_id, *self.render_shop(park, d))
        elif kind == "S":  # выбрана смена → подтверждение
            rule = next((r for r in self.shift_rules(park) if r["id"] == args[0]), None)
            if not rule:
                self.answer(cq, "Смена недоступна")
                return
            self.answer(cq)
            text = (f"🛒 Подключить смену <b>{fleet.esc(rule.get('name'))}</b>?\n\n"
                    f"🔒 Отключить её можно будет не раньше чем через <b>{self.min_days} дн.</b> "
                    f"— с {local(now_utc() + timedelta(days=self.min_days))}.")
            kb = [[fleet.btn("✅ Подтверждаю", f"Y|{rule['id']}"), fleet.btn("❌ Отмена", "R")]]
            self.tg.edit(chat_id, message_id, text, kb)
        elif kind == "Y":
            self.buy(cq, park, d, args[0])
        elif kind == "X":
            self.disable(cq, park, d)
        else:
            self.answer(cq)

    def buy(self, cq, park, d, rule_id):
        chat_id, message_id = cq["message"]["chat"]["id"], cq["message"]["message_id"]
        rule = next((r for r in self.shift_rules(park) if r["id"] == rule_id), None)
        current = (fleet.driver_profile_v2(park, d["id"]).get("account") or {}).get("work_rule_id", "")
        if not rule:
            self.answer(cq, "Смена недоступна")
            return
        if self.shift_info(park, d["id"], current):
            self.answer(cq, "Смена уже подключена")
            self.tg.edit(chat_id, message_id, *self.render_cabinet(park, d))
            return
        self.answer(cq, "⏳ Подключаю…")
        fleet.set_work_rule(park, d["id"], rule_id)
        self.state["shifts"][d["id"]] = {
            "park_id": park["park_id"], "rule_id": rule_id, "rule_name": rule.get("name") or "Смена",
            "started_at": now_utc().isoformat(), "prev_rule_id": park.get("default_rule_id") or current,
        }
        self._save_state()
        log(f"смена куплена: {fleet.full_name(d)} → {rule.get('name')}")
        self.notify_staff(f"🛒 Смена куплена: <b>{fleet.esc(fleet.full_name(d))}</b> → «{fleet.esc(rule.get('name'))}»"
                          f" · {fleet.esc(park.get('name', ''))}")
        text, kb = self.render_cabinet(park, d)
        self.tg.edit(chat_id, message_id, "✅ <b>Смена подключена!</b>\n\n" + text, kb)

    def disable(self, cq, park, d):
        chat_id, message_id = cq["message"]["chat"]["id"], cq["message"]["message_id"]
        current = (fleet.driver_profile_v2(park, d["id"]).get("account") or {}).get("work_rule_id", "")
        rec = self.shift_info(park, d["id"], current)
        if not rec:
            self.answer(cq, "Смена не подключена")
            self.tg.edit(chat_id, message_id, *self.render_cabinet(park, d))
            return
        unlock = self.unlock_at(rec)
        if now_utc() < unlock:
            self.answer(cq, f"🔒 Отключить смену можно только через {self.min_days} дн. — с {local(unlock)}",
                        alert=True)
            return
        target = rec.get("prev_rule_id") or park.get("default_rule_id")
        shift_ids = {r["id"] for r in self.shift_rules(park)}
        if not target or target in shift_ids:
            self.answer(cq, "Не настроено условие для возврата. Обратитесь к диспетчеру.", alert=True)
            return
        self.answer(cq, "⏳ Отключаю…")
        fleet.set_work_rule(park, d["id"], target)
        self.state["shifts"].pop(d["id"], None)
        self._save_state()
        log(f"смена отключена: {fleet.full_name(d)}")
        self.notify_staff(f"⛔ Смена отключена: <b>{fleet.esc(fleet.full_name(d))}</b> · «{fleet.esc(rec['rule_name'])}»"
                          f" · {fleet.esc(park.get('name', ''))}")
        text, kb = self.render_cabinet(park, d)
        self.tg.edit(chat_id, message_id, "✅ <b>Смена отключена.</b>\n\n" + text, kb)

    def notify_staff(self, text):
        if not self.staff_tg:
            return
        for chat in self.staff_chats:
            try:
                self.staff_tg.send(chat, text)
            except Exception as e:
                log(f"не удалось уведомить {chat}: {e}")

    def answer(self, cq, text="", alert=False):
        try:
            self.tg.call("answerCallbackQuery", callback_query_id=cq["id"], text=text, show_alert=alert)
        except Exception:
            pass

    # ---------- цикл ----------

    def run(self):
        me = self.tg.call("getMe")
        self.tg.call("setMyCommands", commands=[{"command": "start", "description": "Личный кабинет"}])
        log(f"бот водителей @{me['username']} запущен, парков: {len(self.parks)}, отключение смены через "
            f"{self.min_days} дн.")
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
                except Exception:
                    log("ошибка обработки:\n" + traceback.format_exc())
                    chat = (upd.get("message") or upd.get("callback_query", {}).get("message") or {}).get("chat", {})
                    if chat.get("id"):
                        try:
                            self.tg.send(chat["id"], "❌ Что-то пошло не так. Попробуйте ещё раз "
                                                     "или обратитесь к диспетчеру.")
                        except Exception:
                            pass


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    DriverBot().run()
