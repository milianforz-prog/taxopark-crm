"""Общий модуль: настройки, Fleet API (Яндекс Про), оформление сообщений и кнопки для бота."""

import html
import json
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
FLEET_URL = "https://fleet-api.taxi.yandex.net/v1/parks/driver-profiles/list"
PAGE_SIZE_API = 1000
LIST_PAGE = 10  # водителей на одной странице списка
CACHE_TTL = 120  # секунд
THRESHOLDS = [3000, 5000, 10000, 20000]

WORK_STATUS = {"working": "работает", "not_working": "не работает", "fired": "уволен"}
CURRENT_STATUS = {
    "offline": "⚫ офлайн",
    "free": "🟢 свободен",
    "busy": "🟡 занят",
    "in_order": "🚖 на заказе",
}
ONLINE = {"free", "busy", "in_order"}


# ---------- настройки ----------

def load_env():
    env = {}
    path = BASE_DIR / ".env"
    if path.exists():
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                key, value = line.split("=", 1)
                env[key.strip()] = value.strip().strip('"').strip("'")
    return env


def load_parks(env):
    """Парки из parks.json; если файла нет — один парк из .env."""
    path = BASE_DIR / "parks.json"
    if path.exists():
        parks = json.loads(path.read_text(encoding="utf-8"))
    elif env.get("PARK_ID"):
        parks = [{"name": "", "park_id": env["PARK_ID"],
                  "client_id": env.get("CLIENT_ID", ""), "api_key": env["API_KEY"]}]
    else:
        raise RuntimeError("Не найдено ни одного парка: заполните parks.json")
    for p in parks:
        p.setdefault("client_id", "")
        p["client_id"] = p["client_id"] or f"taxi/park/{p['park_id']}"
    return parks


def threshold_from_env(env):
    return abs(int(float(env.get("BALANCE_THRESHOLD", "5000"))))


def allowed_chats(env):
    return {c.strip() for c in env.get("TELEGRAM_CHAT_ID", "").split(",") if c.strip()}


# ---------- HTTP ----------

def post_json(url, payload, headers=None, timeout=60):
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=data, method="POST")
    req.add_header("Content-Type", "application/json")
    for key, value in (headers or {}).items():
        req.add_header(key, value)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {e.code}: {body}") from None


# ---------- Fleet API ----------

_cache = {}  # park_id -> (время, водители)


def fetch_park(park, force=False):
    cached = _cache.get(park["park_id"])
    if cached and not force and time.time() - cached[0] < CACHE_TTL:
        return cached[1]
    headers = {"X-Client-ID": park["client_id"], "X-API-Key": park["api_key"], "Accept-Language": "ru"}
    drivers, offset = [], 0
    while True:
        payload = {
            "query": {"park": {"id": park["park_id"]}},
            "fields": {
                "account": ["balance", "last_transaction_date"],
                "driver_profile": ["id", "first_name", "last_name", "middle_name", "phones",
                                   "work_status", "hire_date"],
                "current_status": ["status", "status_updated_at"],
                "car": ["brand", "model", "number"],
                "park": ["name"],
            },
            "limit": PAGE_SIZE_API,
            "offset": offset,
        }
        resp = post_json(FLEET_URL, payload, headers)
        if not park.get("name"):
            park["name"] = next((p.get("name") for p in resp.get("parks", []) if p.get("name")), "Парк")
        page = resp.get("driver_profiles", [])
        drivers.extend(_parse_driver(item) for item in page)
        offset += len(page)
        if not page or offset >= resp.get("total", 0):
            break
    _cache[park["park_id"]] = (time.time(), drivers)
    return drivers


def _parse_driver(item):
    profile = item.get("driver_profile", {})
    account = (item.get("accounts") or [{}])[0]
    status = item.get("current_status") or {}
    car = item.get("car") or {}
    return {
        "id": profile.get("id", ""),
        "last_name": profile.get("last_name", ""),
        "first_name": profile.get("first_name", ""),
        "middle_name": profile.get("middle_name", ""),
        "phone": (profile.get("phones") or [""])[0],
        "work_status": profile.get("work_status", ""),
        "hire_date": profile.get("hire_date"),
        "balance": float(account.get("balance") or 0),
        "last_transaction": account.get("last_transaction_date"),
        "status": status.get("status", ""),
        "status_at": status.get("status_updated_at"),
        "car": " ".join(x for x in (car.get("brand"), car.get("model")) if x),
        "car_number": car.get("number", ""),
    }


def selected_parks(parks, sel):
    """sel: индекс парка (str) или 'a' — все парки. Возвращает [(индекс, парк)]."""
    if sel == "a" or not sel.isdigit() or int(sel) >= len(parks):
        return list(enumerate(parks))
    return [(int(sel), parks[int(sel)])]


def collect(parks, sel, force=False):
    """Водители выбранных парков, у каждого отмечен индекс парка."""
    result = []
    for idx, park in selected_parks(parks, sel):
        for d in fetch_park(park, force):
            result.append({**d, "park_idx": idx})
    return result


def debtors(drivers, threshold, skip_fired=True):
    items = [d for d in drivers if d["balance"] <= -threshold
             and not (skip_fired and d["work_status"] == "fired")]
    return sorted(items, key=lambda d: d["balance"])


def search(drivers, query):
    q = query.lower().strip()
    digits = "".join(ch for ch in q if ch.isdigit())
    found = []
    for d in drivers:
        name = f"{d['last_name']} {d['first_name']} {d['middle_name']}".lower()
        if (len(digits) >= 4 and digits in d["phone"]) or all(part in name for part in q.split()):
            found.append(d)
    return sorted(found, key=lambda d: (d["work_status"] == "fired", d["last_name"]))


# ---------- оформление ----------

def money(x):
    sign = "−" if x < 0 else ""
    return f"{sign}{abs(x):,.0f} ₽".replace(",", " ")


def short_money(x):
    v = abs(x)
    text = f"{v / 1000:.1f}к".replace(".0к", "к") if v >= 1000 else f"{v:.0f}"
    return ("−" if x < 0 else "") + text


def esc(s):
    return html.escape(s or "")


def full_name(d, middle=False):
    parts = [d["last_name"], d["first_name"]] + ([d["middle_name"]] if middle else [])
    return " ".join(p for p in parts if p) or "Без имени"


def _parse_dt(value):
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone()
    except ValueError:
        return None


def ago(value):
    dt = _parse_dt(value)
    if not dt:
        return ""
    sec = (datetime.now(timezone.utc) - dt).total_seconds()
    if sec < 3600:
        return f"{max(1, int(sec // 60))} мин"
    if sec < 86400:
        return f"{int(sec // 3600)} ч"
    return f"{int(sec // 86400)} дн"


def fmt_date(value, with_time=True):
    dt = _parse_dt(value)
    if not dt:
        return "—"
    return dt.strftime("%d.%m.%Y %H:%M" if with_time else "%d.%m.%Y")


def park_title(parks, sel):
    chosen = selected_parks(parks, sel)
    if len(chosen) == 1:
        return chosen[0][1].get("name") or "Парк"
    return f"Все парки ({len(chosen)})"


def status_line(d):
    text = CURRENT_STATUS.get(d["status"], "⚫ офлайн")
    since = ago(d["status_at"])
    if since:
        text += f" {since}"
    if d["work_status"] in ("not_working", "fired"):
        text += f" · ⛔ {WORK_STATUS[d['work_status']]}"
    return text


def render_debtors(parks, sel, threshold, page, force=False):
    drivers = collect(parks, sel, force)
    items = debtors(drivers, threshold)
    pages = max(1, -(-len(items) // LIST_PAGE))
    page = min(max(page, 0), pages - 1)
    now = datetime.now().strftime("%d.%m %H:%M")
    multi = len(selected_parks(parks, sel)) > 1

    lines = [
        f"💸 <b>Должники от {money(-threshold)}</b>",
        f"🏢 {esc(park_title(parks, sel))}",
    ]
    if not items:
        lines += ["", f"✅ Водителей с балансом {money(-threshold)} и ниже нет",
                  f"<i>Проверено {len(drivers)} водителей · {now}</i>"]
    else:
        lines += [
            f"👥 <b>{len(items)}</b> из {len(drivers)} · итого <b>{money(sum(d['balance'] for d in items))}</b>",
            f"<i>🔄 {now} · стр. {page + 1}/{pages}</i>",
            "",
        ]
        start = page * LIST_PAGE
        for n, d in enumerate(items[start:start + LIST_PAGE], start + 1):
            lines.append(f"<b>{n}. {esc(full_name(d))}</b>")
            lines.append(f"     💸 <b>{money(d['balance'])}</b> · {status_line(d)}")
            extra = []
            if d["phone"]:
                extra.append(f"📞 {d['phone']}")
            if d["car_number"]:
                extra.append(f"🚗 {esc(d['car_number'])}")
            if multi:
                extra.append(f"🏢 {esc(parks[d['park_idx']].get('name', ''))}")
            if extra:
                lines.append("     " + " · ".join(extra))
            lines.append("")

    kb = []
    start = page * LIST_PAGE
    row = []
    for n, d in enumerate(items[start:start + LIST_PAGE], start + 1):
        row.append(btn(f"{n}. {d['last_name'] or d['first_name']} {short_money(d['balance'])}",
                       f"D|{d['park_idx']}|{d['id']}|{sel}|{threshold}|{page}"))
        if len(row) == 2:
            kb.append(row)
            row = []
    if row:
        kb.append(row)
    if pages > 1:
        kb.append([
            btn("◀️" if page > 0 else "·", f"L|{sel}|{threshold}|{page - 1}" if page > 0 else "N"),
            btn(f"{page + 1} / {pages}", "N"),
            btn("▶️" if page < pages - 1 else "·", f"L|{sel}|{threshold}|{page + 1}" if page < pages - 1 else "N"),
        ])
    kb.append([btn(("✓ " if t == threshold else "") + short_money(-t), f"L|{sel}|{t}|0") for t in THRESHOLDS]
              + [btn("✏️ Свой", f"T|{sel}")])
    kb.append([btn("🔄 Обновить", f"R|{sel}|{threshold}|{page}")])
    return "\n".join(lines).rstrip(), kb


def render_card(parks, park_idx, driver_id, back=None, force=False):
    park = parks[park_idx]
    d = next((x for x in fetch_park(park, force) if x["id"] == driver_id), None)
    if not d:
        return "Водитель не найден", [[btn("⬅️ Назад", back)]] if back else []
    online = d["status"] in ONLINE
    bal_icon = "🔴" if d["balance"] < 0 else "🟢"
    lines = [
        f"👤 <b>{esc(full_name(d, middle=True))}</b>",
        f"🏢 {esc(park.get('name', ''))}",
        "",
        f"{bal_icon} Баланс: <b>{money(d['balance'])}</b>",
        f"📞 {d['phone'] or '—'}",
        f"🚗 {esc(' · '.join(x for x in (d['car'], d['car_number']) if x)) or '—'}",
        "",
        f"📋 В парке: {WORK_STATUS.get(d['work_status'], d['work_status'] or '—')}",
        f"📍 Сейчас: {CURRENT_STATUS.get(d['status'], '⚫ офлайн')}",
        f"🕐 {'На линии с' if online else 'Последний раз на линии'}: "
        f"{fmt_date(d['status_at'])}" + (f" ({ago(d['status_at'])} назад)" if d["status_at"] else ""),
        f"💳 Последняя операция: {fmt_date(d['last_transaction'])}",
        f"📅 Принят: {fmt_date(d['hire_date'], with_time=False)}",
    ]
    refresh = f"F|{park_idx}|{driver_id}" + (f"|{back}" if back else "")
    kb = [[btn("🔄 Обновить", refresh[:64])]]
    if back:
        kb[0].append(btn("⬅️ К списку", back))
    return "\n".join(lines), kb


def render_summary(parks, sel, threshold, force=False):
    now = datetime.now().strftime("%d.%m %H:%M")
    lines = [f"📊 <b>Сводка</b> · <i>{now}</i>", ""]
    total = {"plus": 0.0, "minus": 0.0, "online": 0, "debt": 0.0, "debtors": 0}
    chosen = selected_parks(parks, sel)
    for idx, park in chosen:
        ds = fetch_park(park, force)
        active = [d for d in ds if d["work_status"] == "working"]
        online = [d for d in ds if d["status"] in ONLINE]
        plus = sum(d["balance"] for d in ds if d["balance"] > 0)
        minus = sum(d["balance"] for d in ds if d["balance"] < 0)
        debt_items = debtors(ds, threshold)
        debt = sum(d["balance"] for d in debt_items)
        by = {s: sum(1 for d in online if d["status"] == s) for s in ONLINE}
        lines += [
            f"🏢 <b>{esc(park.get('name', ''))}</b>",
            f"👥 Водителей: {len(ds)} · работают {len(active)}",
            f"🟢 На линии: <b>{len(online)}</b> (свободны {by['free']}, на заказе {by['in_order']}, заняты {by['busy']})",
            f"💰 Сумма в плюсе: <b>{money(plus)}</b> ({sum(1 for d in ds if d['balance'] > 0)} вод.)",
            f"🔴 Сумма в минусе: <b>{money(minus)}</b> ({sum(1 for d in ds if d['balance'] < 0)} вод.)",
            f"💸 Должники от {money(-threshold)}: <b>{len(debt_items)}</b> на {money(debt)}",
            "",
        ]
        total["plus"] += plus
        total["minus"] += minus
        total["online"] += len(online)
        total["debt"] += debt
        total["debtors"] += len(debt_items)
    if len(chosen) > 1:
        lines += [
            "📈 <b>Итого по всем паркам</b>",
            f"🟢 На линии: <b>{total['online']}</b>",
            f"💰 В плюсе: <b>{money(total['plus'])}</b> · 🔴 в минусе: <b>{money(total['minus'])}</b>",
            f"💸 Должники: <b>{total['debtors']}</b> на {money(total['debt'])}",
        ]
    kb = [[btn("💸 Показать должников", f"L|{sel}|{threshold}|0"), btn("🔄 Обновить", f"S|{sel}|1")]]
    return "\n".join(lines).rstrip(), kb


def render_search(parks, sel, query):
    found = search(collect(parks, sel), query)
    if not found:
        return f"🔍 По запросу «{esc(query)}» никого не нашёл. Попробуйте фамилию или последние цифры телефона.", []
    if len(found) > 30:
        return f"🔍 Нашёл {len(found)} водителей — уточните запрос (фамилия и имя).", []
    lines = [f"🔍 Найдено: <b>{len(found)}</b>. Выберите водителя:"]
    kb = [[btn(f"{full_name(d)} · {short_money(d['balance'])}" + (" ⛔" if d["work_status"] == "fired" else ""),
               f"C|{d['park_idx']}|{d['id']}")] for d in found]
    return "\n".join(lines), kb


def render_parks(parks, sel):
    lines = ["🏢 <b>Выберите парк</b>", f"Сейчас: {esc(park_title(parks, sel))}"]
    for _, park in enumerate(parks):
        if not park.get("name"):
            try:
                fetch_park(park)
            except Exception:
                park["name"] = park["park_id"][:8]
    kb = [[btn(("✓ " if sel == str(i) else "") + (p.get("name") or "Парк"), f"P|{i}")] for i, p in enumerate(parks)]
    kb.append([btn(("✓ " if sel == "a" else "") + f"🌐 Все парки ({len(parks)})", "P|a")])
    if len(parks) == 1:
        lines.append("\n<i>Чтобы добавить парки, допишите их в файл parks.json.</i>")
    return "\n".join(lines), kb


def btn(text, data):
    return {"text": text, "callback_data": data}


# ---------- Telegram ----------

class Telegram:
    def __init__(self, token):
        self.base = f"https://api.telegram.org/bot{token}/"

    def call(self, method, http_timeout=60, **params):
        resp = post_json(self.base + method, params, timeout=http_timeout)
        if not resp.get("ok"):
            raise RuntimeError(resp)
        return resp.get("result")

    def send(self, chat_id, text, kb=None, reply_kb=None):
        params = {"chat_id": chat_id, "text": text, "parse_mode": "HTML", "disable_web_page_preview": True}
        if kb is not None:
            params["reply_markup"] = {"inline_keyboard": kb}
        elif reply_kb is not None:
            params["reply_markup"] = reply_kb
        return self.call("sendMessage", **params)

    def edit(self, chat_id, message_id, text, kb=None):
        try:
            self.call("editMessageText", chat_id=chat_id, message_id=message_id, text=text,
                      parse_mode="HTML", disable_web_page_preview=True,
                      reply_markup={"inline_keyboard": kb or []})
        except RuntimeError as e:
            if "message is not modified" not in str(e):
                raise
