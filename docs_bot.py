"""Telegram-бот: заявление на смену банковских реквизитов.

Пользователь присылает одним сообщением расчётный счёт, банк, БИК,
корреспондентский счёт, наименование, ИНН, КПП (если есть) и номер договора
сервиса (72388964/26 или ОФ-…). Бот заполняет бланк Word и присылает .docx
и картинку страницы — с телефона картинку сохранить проще, чем файл.

ОГРН/ОГРНИП бот сам не подставляет. Нет номера в сообщении — поле пустое,
и об этом написано в ответе.

Запуск:
  python docs_bot.py
Токен — переменная окружения DOCS_BOT_TOKEN (или такая же строка в .env).
Если токена нет, бот пишет об этом и не падает.
Доступ — TELEGRAM_CHAT_ID, как у бота балансов.
Картинка: pip install pillow

Проверка без Telegram:
  python docs_bot.py --check
  python docs_bot.py --fill "текст сообщения" --out папка
"""

import json
import os
import re
import sys
import tempfile
import time
import traceback
import urllib.request
import uuid
import zipfile
from datetime import datetime
from pathlib import Path
from xml.etree import ElementTree as ET

import fleet

TEMPLATE = Path(__file__).resolve().parent / "templates" / "zayavlenie-rekvizity.docx"
W_T = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}t"

HINT = (
    "Пришлите <b>одним сообщением</b> расчётный счёт, банк, БИК, к/с,\n"
    "наименование, ИНН, КПП если есть и номер договора\n"
    "(72388964/26 или ОФ-12345678/25).\n"
    "ОГРН добавьте только если он у вас есть: сам номер я не подставлю.\n\n"
    "Пример:\n"
    "<code>Расчётный счёт: 4070…\n"
    "Банк: ООО \"Банк\"\n"
    "БИК: 044525104\n"
    "К/с: 3010…\n"
    "Наименование: ООО Ромашка\n"
    "ИНН: …\n"
    "Договор: ОФ-12345678/25</code>"
)

_COEF23 = (7, 1, 3, 7, 1, 3, 7, 1, 3, 7, 1, 3, 7, 1, 3, 7, 1, 3, 7, 1, 3, 7, 1)
_DUP = {
    "account": "Расчётных счетов несколько — оставьте один.",
    "ks": "Корреспондентских счетов несколько — оставьте один.",
    "bik": "БИК указан дважды.",
    "inn": "ИНН указан дважды.",
    "kpp": "КПП указан дважды.",
    "ogrn": "ОГРН указан дважды.",
    "name": "Наименование указано дважды.",
    "bank": "Банк указан дважды.",
}

_DIGIT_LABELS = (
    # к/с раньше р/с: в «Корр. сч.» буква «р» не должна становиться расчётным счётом.
    ("ks", re.compile(
        r"корреспондентск\w*(?:\s+сч[её]т\w*)?"
        r"|(?<!\w)корр?\.?\s*сч(?:[её]т)?\.?"
        r"|(?<!\w)корр?\s*/\s*сч(?:[её]т)?"
        r"|(?<!\w)к\s*/\s*сч?"
        r"|(?<!\w)к\.?\s*сч\.?",
        re.I), (20,)),
    ("account", re.compile(
        r"расч[её]тн\w*\s+сч[её]т\w*|(?<!\w)р\s*/\s*сч?|(?<!\w)р\.?\s*сч\.?",
        re.I), (20,)),
    ("account", re.compile(
        r"(?:^|[\n;,])\s*сч(?:[её]т)?\.?(?=\s*(?:[:.\-№#]|\d))",
        re.I | re.M), (20,)),
    ("ogrn", re.compile(r"огрнип|огрн", re.I), (13, 15)),
    ("bik", re.compile(r"(?<!\w)бик(?!\w)", re.I), (9,)),
    ("inn", re.compile(r"(?<!\w)инн(?!\w)", re.I), (10, 12)),
    ("kpp", re.compile(r"(?<!\w)кпп(?!\w)", re.I), (9,)),
)

_TEXT_LABELS = (
    ("bank", re.compile(
        r"(?:^|[\n;,])\s*банк(?:\s+получателя)?\s*:\s*",
        re.I | re.M)),
    ("name", re.compile(
        r"(?:^|[\n;,])\s*(?:наименование(?:\s+организации)?|организация|"
        r"юр(?:идическое)?\.?\s*лицо|получатель)\s*:\s*",
        re.I | re.M)),
)

_CONTRACT_RE = re.compile(
    r"(?i)(?<!\w)((?:оф|of|рас|смз)(?=[\s\-–—]))\s*[-–—]?\s*(\d{5,12})\s*[/\-–—]\s*(\d{2})(?!\d)"
    r"|(?<!\d)(\d{6,12})\s*[/\-]\s*(\d{2})(?!\d)"
)

_ABSENT_RE = re.compile(r"[\s:.\-]*(нет|не\s*указа\w*|отсутствует)\b", re.I)
_JUNK = {
    "добрый день", "здравствуйте", "привет", "реквизиты", "заявление", "данные",
    "вот", "спасибо", "пожалуйста", "вот реквизиты", "смена реквизитов",
    "договор", "договор сервиса", "номер договора", "оф", "рас", "смз",
}


def log(msg):
    line = f"{datetime.now():%d.%m %H:%M:%S} {msg}"
    print(line, flush=True)
    with open(fleet.BASE_DIR / "docs_bot.log", "a", encoding="utf-8") as f:
        f.write(line + "\n")


def safe_err(text):
    return re.sub(r"bot\d+:[A-Za-z0-9_-]+", "bot***", str(text))


def today_ru():
    try:
        from zoneinfo import ZoneInfo
        now = datetime.now(ZoneInfo("Europe/Moscow"))
    except Exception:
        now = datetime.now()
    return now.strftime("%d.%m.%Y")


def token_from_env():
    env = fleet.load_env()
    return os.environ.get("DOCS_BOT_TOKEN", "").strip() or env.get("DOCS_BOT_TOKEN", "").strip()


# ---------- проверка номеров ----------

def _ctrl(seed, account):
    row = seed + account
    return sum(int(row[i]) * _COEF23[i] for i in range(23)) % 10 == 0


def account_ok(bik, account):
    return len(account) == 20 and len(bik) >= 9 and _ctrl(bik[-3:], account)


def ks_ok(bik, ks):
    return len(ks) == 20 and len(bik) >= 6 and _ctrl("0" + bik[4:6], ks)


def inn_ok(inn):
    digits = [int(ch) for ch in inn]
    if len(inn) == 10:
        coef = (2, 4, 10, 3, 5, 9, 4, 6, 8)
        return sum(digits[i] * coef[i] for i in range(9)) % 11 % 10 == digits[9]
    if len(inn) == 12:
        first = (7, 2, 4, 10, 3, 5, 9, 4, 6, 8)
        second = (3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8)
        n11 = sum(digits[i] * first[i] for i in range(10)) % 11 % 10
        n12 = sum(digits[i] * second[i] for i in range(11)) % 11 % 10
        return n11 == digits[10] and n12 == digits[11]
    return False


def ogrn_ok(ogrn):
    if len(ogrn) == 13 and ogrn.isdigit():
        return int(ogrn[:12]) % 11 % 10 == int(ogrn[12])
    if len(ogrn) == 15 and ogrn.isdigit():
        return int(ogrn[:14]) % 13 % 10 == int(ogrn[14])
    return False


# ---------- разбор сообщения ----------

def _normalize(text):
    text = text.replace("\u00a0", " ").replace("\u202f", " ")
    text = text.replace("«", '"').replace("»", '"').replace("“", '"').replace("”", '"')
    text = text.replace("–", "-").replace("—", "-").replace("−", "-")
    return text.strip()


def _blank(text, start, end):
    return text[:start] + (" " * (end - start)) + text[end:]


def _take_number(after, lengths):
    sep = re.match(r"[\s:.\-№#]*", after)
    rest = after[sep.end():]
    limit = max(lengths)
    digits = []
    i = 0
    while i < len(rest) and len(digits) < limit:
        ch = rest[i]
        if ch.isdigit():
            digits.append(ch)
            i += 1
            continue
        if ch == " " and digits and i + 1 < len(rest) and rest[i + 1].isdigit():
            i += 1
            continue
        break
    got = "".join(digits)
    if len(got) not in lengths:
        return None, 0
    return got, sep.end() + i


def _read_text_value(text, start):
    out = []
    quote = False
    i = start
    while i < len(text):
        ch = text[i]
        if ch == '"':
            quote = not quote
            out.append(ch)
        elif ch in "\n;" or (ch == "," and not quote):
            break
        else:
            out.append(ch)
        i += 1
    return "".join(out).strip(), i


def _canon_contract(prefix, number, year):
    prefix = re.sub(r"[\s\-]+", "", prefix or "").upper().replace("OF", "ОФ")
    if prefix in ("ОФ", "РАС", "СМЗ"):
        return f"{prefix}-{number}/{year}"
    return f"{number}/{year}"


def _assign(values, problems, field, value):
    if field in values and values[field] != value:
        if _DUP[field] not in problems:
            problems.append(_DUP[field])
        return
    values[field] = value


def _bank_score(line):
    low = line.lower()
    score = 0
    if re.search(r"\bбанк\b", low):
        score += 2
    if re.search(r"\b(пао|ао)\b", low) and "банк" in low:
        score += 2
    if re.search(r"\b(общество|предприниматель|индивидуальный)\b", low):
        score -= 2
    if re.search(r"\bип\b", low):
        score -= 2
    return score


def _org_score(line):
    low = line.lower()
    score = 0
    if re.search(r"\b(ооо|общество|ип|предприниматель|индивидуальный|ао|пао|зао|нао)\b", low):
        score += 2
    if re.search(r"\bбанк\b", low):
        score -= 1
    return score


def _strip_prefix(line):
    line = re.sub(
        r"^(?:банк(?:\s+получателя)?|наименование(?:\s+организации)?|организация|получатель|"
        r"юр(?:идическое)?\.?\s*лицо|расч[её]тн\w*\s+сч[её]т\w*|"
        r"корреспондентск\w*(?:\s+сч[её]т\w*)?)\s*[:\-–]?\s*",
        "", line, count=1, flags=re.I).strip()
    line = re.sub(r"^в\s+(?=ооо|пао|ао|ип\b)", "", line, count=1, flags=re.I).strip()
    return line.strip(" \t:;-")


def _is_junk(line):
    low = line.lower().strip(" .,:;!-\"")
    if not low or low in _JUNK:
        return True
    if re.fullmatch(r"[\W_]+", line):
        return True
    return False


def _split_fragments(text):
    parts = []
    for line in text.splitlines():
        buf, quote = [], False
        for ch in line:
            if ch == '"':
                quote = not quote
                buf.append(ch)
            elif ch == "," and not quote:
                parts.append("".join(buf))
                buf = []
            else:
                buf.append(ch)
        parts.append("".join(buf))
    return parts


def _collapse_line(line):
    if re.fullmatch(r"[\d\s]+", line.strip()):
        digits = re.sub(r"\s+", "", line)
        if len(digits) in (9, 10, 12, 13, 15, 20):
            return digits
    return line


def parse_message(text):
    """Возвращает (data, problems). data is None, если бланк заполнять нельзя."""
    raw = _normalize(text or "")
    if not raw:
        return None, ["Пустое сообщение."]

    problems = []
    notes = []
    values = {}
    seen = set()
    working = raw
    contracts = []
    for match in list(_CONTRACT_RE.finditer(working)):
        if match.group(2):
            contracts.append(_canon_contract(match.group(1), match.group(2), match.group(3)))
        else:
            contracts.append(_canon_contract("", match.group(4), match.group(5)))
        working = _blank(working, match.start(), match.end())
    # уникальные, в порядке появления
    uniq = []
    for item in contracts:
        if item not in uniq:
            uniq.append(item)
    contracts = uniq
    for_all = bool(re.search(r"по\s+всем", working, re.I))
    working = re.sub(r"по\s+всем(?:\s+договорам)?", " ", working, flags=re.I)

    for field, regex in _TEXT_LABELS:
        pos = 0
        while True:
            match = regex.search(working, pos)
            if not match:
                break
            value, end = _read_text_value(working, match.end())
            if value:
                _assign(values, problems, field, value)
            working = _blank(working, match.start(), end)
            pos = end

    for field, regex, lengths in _DIGIT_LABELS:
        pos = 0
        while True:
            match = regex.search(working, pos)
            if not match:
                break
            seen.add(field)
            after = working[match.end():]
            absent = _ABSENT_RE.match(after) if field in ("ogrn", "kpp") else None
            if absent:
                values.pop(field, None)
                values[field + "_absent"] = True
                working = _blank(working, match.start(), match.end() + absent.end())
                pos = match.end() + absent.end()
                continue
            number, taken = _take_number(after, lengths)
            if not number:
                working = _blank(working, match.start(), match.end())
                pos = match.end()
                continue
            _assign(values, problems, field, number)
            working = _blank(working, match.start(), match.end() + taken)
            pos = match.end() + taken

    working = "\n".join(_collapse_line(line) for line in working.splitlines())
    for match in re.finditer(r"\d{20}|\d{15}|\d{13}|\d{12}|\d{10}|\d{9}", working):
        number = match.group(0)
        if len(number) == 20:
            field = "ks" if number.startswith("301") else "account"
        elif len(number) == 15 or len(number) == 13:
            field = "ogrn"
        elif len(number) == 12 or len(number) == 10:
            field = "inn"
        elif number.startswith("04"):
            field = "bik"
        else:
            field = "kpp"
        _assign(values, problems, field, number)
        seen.add(field)

    if values.get("ogrn_absent"):
        values.pop("ogrn", None)
    if values.get("kpp_absent"):
        values.pop("kpp", None)

    fragments = []
    for part in _split_fragments(working):
        part = _strip_prefix(part)
        if part and not _is_junk(part) and not re.fullmatch(r"[\d\s]+", part):
            fragments.append(part)
    name = values.get("name", "")
    bank = values.get("bank", "")
    extras = []
    if fragments and (not name or not bank):
        if name and not bank:
            bank, leftovers = _pick(fragments, _bank_score, _org_score)
            extras = leftovers
        elif bank and not name:
            name, leftovers = _pick(fragments, _org_score, _bank_score)
            extras = leftovers
        else:
            name, bank, extras = _pick_both(fragments)
    elif fragments and name and bank:
        extras = fragments

    kept = []
    for extra in extras:
        if re.match(r"г\.?\s+\S", extra, re.I) and bank:
            bank = bank.rstrip(",") + ", " + extra
        else:
            kept.append(extra)
    for extra in kept:
        notes.append(f"Строку «{extra}» в бланк не ставил.")

    if "ogrn" in seen and not values.get("ogrn") and not values.get("ogrn_absent"):
        problems.append("ОГРН указан, но это не 13 и не 15 цифр. Я его не исправляю.")
    if "kpp" in seen and not values.get("kpp") and not values.get("kpp_absent"):
        problems.append("КПП указан, но в нём не 9 цифр.")

    missing = []
    for field, title in (
        ("account", "расчётный счёт"),
        ("bank", "банк"),
        ("bik", "БИК"),
        ("ks", "корреспондентский счёт"),
        ("name", "наименование"),
        ("inn", "ИНН"),
    ):
        if field == "name" and not name:
            missing.append(title)
        elif field == "bank" and not bank:
            missing.append(title)
        elif field not in ("name", "bank") and not values.get(field):
            missing.append(title)
    if not contracts:
        missing.append("номер договора")
    if missing:
        problems.append("Не хватает: " + ", ".join(missing) + ".")

    account = values.get("account", "")
    ks = values.get("ks", "")
    bik = values.get("bik", "")
    inn = values.get("inn", "")
    ogrn = values.get("ogrn", "")
    kpp = values.get("kpp", "")

    if account and not account.startswith("301") and bik and not account_ok(bik, account):
        problems.append("Расчётный счёт не сходится с БИК. Проверьте номера, я их не исправляю.")
    if account.startswith("301"):
        problems.append("Расчётный счёт выглядит как корреспондентский (начинается с 301).")
    if ks and not ks.startswith("301"):
        problems.append("Корреспондентский счёт должен начинаться с 301.")
    elif ks and bik and not ks_ok(bik, ks):
        problems.append("Корреспондентский счёт не сходится с БИК. Проверьте номера, я их не исправляю.")
    if bik and not bik.startswith("04"):
        problems.append("БИК российского банка начинается с 04.")
    if inn and not inn_ok(inn):
        problems.append("ИНН не проходит проверку контрольной цифры.")
    if kpp and (len(kpp) != 9 or not kpp.isdigit()):
        problems.append("КПП — это 9 цифр.")
    if ogrn and not ogrn_ok(ogrn):
        problems.append("ОГРН не проходит проверку контрольной цифры. Я его не исправляю — "
                        "пришлите верный номер или уберите строку, тогда поле останется пустым.")
    if inn and ogrn and ((len(inn) == 10 and len(ogrn) == 15) or (len(inn) == 12 and len(ogrn) == 13)):
        notes.append("ИНН и ОГРН разной длины (организация и ИП). Проверьте, что оба номера этой фирмы.")
    if name and len(name) < 4:
        problems.append("Наименование слишком короткое.")
    if bank and len(bank) < 4:
        problems.append("Название банка слишком короткое.")

    # проблемы не должны повторяться
    unique_problems = []
    for item in problems:
        if item not in unique_problems:
            unique_problems.append(item)
    if unique_problems:
        return None, unique_problems

    if not ogrn:
        notes.insert(0, "ОГРН в сообщении не было. Поле в заявлении пустое.")
    if kpp:
        notes.append(f"КПП {kpp} в бланке нет отдельной строки, в заявление его не ставил.")

    contract_line = ", ".join(contracts)
    if for_all:
        contract_line += ", по всем"
    return {
        "account": account,
        "ks": ks,
        "bik": bik,
        "inn": inn,
        "kpp": kpp,
        "ogrn": ogrn,
        "name": name,
        "bank": bank,
        "contracts": contracts,
        "contract_line": contract_line,
        "notes": notes,
        "date": today_ru(),
    }, []


def _pick(lines, primary, secondary):
    if len(lines) == 1:
        return lines[0], []
    index = max(range(len(lines)), key=lambda i: (primary(lines[i]), -secondary(lines[i]), -i))
    rest = [lines[i] for i in range(len(lines)) if i != index]
    return lines[index], rest


def _pick_both(lines):
    if len(lines) == 1:
        line = lines[0]
        if _bank_score(line) > _org_score(line):
            return "", line, []
        return line, "", []
    bank_i = max(range(len(lines)), key=lambda i: (_bank_score(lines[i]), -_org_score(lines[i])))
    rest = [i for i in range(len(lines)) if i != bank_i]
    name_i = max(rest, key=lambda i: (_org_score(lines[i]), -_bank_score(lines[i])))
    extras = [lines[i] for i in range(len(lines)) if i not in (bank_i, name_i)]
    return lines[name_i], lines[bank_i], extras


# ---------- бланк ----------

def xml_escape(text):
    return (text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;"))


def file_stem(contracts):
    raw = contracts[0].replace("/", "-")
    raw = re.sub(r"[^\w\-]+", "", raw, flags=re.UNICODE).strip("-")
    return "Заявление-" + (raw[:80] or "bez-nomera")


def document_texts(path):
    with zipfile.ZipFile(path) as zf:
        root = ET.fromstring(zf.read("word/document.xml"))
    return [node.text or "" for node in root.iter(W_T)]


def build_docx(data, dest):
    mapping = {
        "{{NAME}}": xml_escape(data["name"]),
        "{{INN}}": xml_escape(data["inn"]),
        "{{OGRN}}": xml_escape(data.get("ogrn") or ""),
        "{{BANK}}": xml_escape(data["bank"]),
        "{{KS}}": xml_escape(data["ks"]),
        "{{BIK}}": xml_escape(data["bik"]),
        "{{ACCOUNT}}": xml_escape(data["account"]),
        "{{CONTRACT}}": xml_escape(data["contract_line"]),
        "{{DATE}}": xml_escape(data["date"]),
    }
    dest = Path(dest)
    dest.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(TEMPLATE) as zin, zipfile.ZipFile(dest, "w", compression=zipfile.ZIP_DEFLATED) as zout:
        for item in zin.infolist():
            blob = zin.read(item.filename)
            if item.filename == "word/document.xml":
                xml = blob.decode("utf-8")
                missing = [key for key in mapping if key not in xml]
                if missing:
                    raise RuntimeError("В шаблоне нет полей: " + ", ".join(missing))
                xml = re.sub(r"\{\{[A-Z]+\}\}", lambda match: mapping[match.group(0)], xml)
                if "{{" in xml:
                    raise RuntimeError("В шаблоне осталась незаполненная метка")
                blob = xml.encode("utf-8")
            zout.writestr(item, blob)
    return dest


def _font_file(bold):
    if bold:
        candidates = [
            "C:/Windows/Fonts/timesbd.ttf",
            "C:/Windows/Fonts/Timesbd.ttf",
            "/usr/share/fonts/truetype/liberation/LiberationSerif-Bold.ttf",
            "/usr/share/fonts/truetype/croscore/Tinos-Bold.ttf",
            "/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf",
        ]
    else:
        candidates = [
            "C:/Windows/Fonts/times.ttf",
            "C:/Windows/Fonts/Times.ttf",
            "/usr/share/fonts/truetype/liberation/LiberationSerif-Regular.ttf",
            "/usr/share/fonts/truetype/croscore/Tinos-Regular.ttf",
            "/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf",
        ]
    for path in candidates:
        if Path(path).exists():
            return path
    raise RuntimeError("Не найден шрифт Times/Liberation с кириллицей")


def _text_width(draw, text, font):
    if hasattr(draw, "textlength"):
        return draw.textlength(text, font=font)
    return font.getlength(text)


def _wrap(draw, text, font, width):
    lines = []
    for paragraph in (text or "").split("\n"):
        words = paragraph.split()
        if not words:
            lines.append("")
            continue
        current = words[0]
        for word in words[1:]:
            trial = current + " " + word
            if _text_width(draw, trial, font) <= width:
                current = trial
            else:
                lines.append(current)
                current = word
        lines.append(current)
    return lines or [""]


def render_png(data, dest):
    """Картинка страницы A4 — её с телефона сохраняют, когда файл не скачивается."""
    try:
        from PIL import Image, ImageDraw, ImageFont
    except ImportError as e:
        raise RuntimeError("Для картинки заявления нужен пакет pillow: pip install pillow") from e

    regular = ImageFont.truetype(_font_file(False), 30)
    bold = ImageFont.truetype(_font_file(True), 34)
    small = ImageFont.truetype(_font_file(False), 24)
    image = Image.new("RGB", (1240, 1754), "white")
    draw = ImageDraw.Draw(image)
    left, right = 60, 1180
    value_x = 490
    gray = (244, 244, 244)
    y = 72

    title = "Заявление на смену банковских реквизитов"
    tw = _text_width(draw, title, bold)
    draw.text(((1240 - tw) / 2, y), title, font=bold, fill="black")
    y += 78

    def heading(text):
        nonlocal y
        for line in _wrap(draw, text, bold, right - left):
            draw.text((left, y), line, font=bold, fill="black")
            y += 42
        y += 8

    def checkbox(checked, caption):
        nonlocal y
        box = 26
        x = left + 8
        top = y + 4
        draw.rectangle([x, top, x + box, top + box], outline="black", width=2)
        if checked:
            draw.line([(x + 5, top + 13), (x + 11, top + 20), (x + 22, top + 6)], fill="black", width=3)
        draw.text((x + box + 12, y), caption, font=regular, fill="black")
        y += 44

    def table(rows):
        nonlocal y
        prepared = []
        for label, values in rows:
            labels = _wrap(draw, label, regular, 390)
            vals = []
            for value in values:
                vals.extend(_wrap(draw, value, regular, right - value_x - 28) if value else [""])
            if not any(vals):
                vals = [""]
            height = max(78, max(len(labels), len(vals)) * 40 + 28)
            prepared.append((labels, vals, height))
        total = sum(item[2] for item in prepared)
        cursor = y
        for labels, vals, height in prepared:
            draw.rectangle([left, cursor, value_x, cursor + height], fill=gray)
            block_h = len(labels) * 40
            text_y = cursor + (height - block_h) / 2
            for line in labels:
                draw.text((left + 18, text_y), line, font=regular, fill="black")
                text_y += 40
            block_h = len(vals) * 40
            text_y = cursor + (height - block_h) / 2
            for line in vals:
                draw.text((value_x + 16, text_y), line, font=regular, fill="black")
                text_y += 40
            cursor += height
        draw.rectangle([value_x, y, right, y + total], outline="black", width=2)
        cursor = y
        for _, _, height in prepared[:-1]:
            cursor += height
            draw.line([(value_x, cursor), (right, cursor)], fill="black", width=2)
        y += total

    heading("Информация о юридическом лице")
    table([
        ("Наименование\nорганизации", [data["name"]]),
        ("ИНН", [data["inn"]]),
        ("ОГРН", [data.get("ogrn") or ""]),
    ])
    y += 28
    heading("Способ получения средств от Сервиса")
    checkbox(True, "на банковские реквизиты")
    checkbox(False, "через B2B СБП")
    y += 12
    heading("На банковские реквизиты")
    table([
        ("Банк получателя", [data["bank"], "к/с " + data["ks"]]),
        ("БИК", [data["bik"]]),
        ("Расчётный счёт", [data["account"]]),
    ])
    y += 28
    heading("Номера договоров, по которым необходимо\nсменить банковские реквизиты")
    box_h = 72
    draw.rectangle([left, y, right, y + box_h], outline="black", width=2)
    draw.text((left + 16, y + 18), data["contract_line"], font=regular, fill="black")
    y += box_h + 36
    draw.text((left + 12, y), data["date"], font=regular, fill="black")
    draw.text((760, y), "м.п.", font=regular, fill="black")
    draw.text((left + 12, y + 40), "(дата)", font=small, fill="black")

    dest = Path(dest)
    dest.parent.mkdir(parents=True, exist_ok=True)
    image.save(dest, "PNG", dpi=(150, 150))
    return dest


def summary_text(data):
    lines = [
        "<b>Заявление готово</b>",
        f"Договор: {fleet.esc(data['contract_line'])}",
        fleet.esc(data["name"]),
        f"ИНН {fleet.esc(data['inn'])}",
        f"Банк: {fleet.esc(data['bank'])}",
        f"БИК {fleet.esc(data['bik'])}",
        f"К/с {fleet.esc(data['ks'])}",
        f"Счёт {fleet.esc(data['account'])}",
    ]
    if data.get("ogrn"):
        lines.append(f"ОГРН {fleet.esc(data['ogrn'])}")
    lines.extend(fleet.esc(note) for note in data.get("notes", []))
    return "\n".join(lines)


def make_files(data, directory):
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    stem = file_stem(data["contracts"])
    docx = directory / f"{stem}.docx"
    png = directory / f"{stem}.png"
    build_docx(data, docx)
    render_png(data, png)
    return docx, png


# ---------- Telegram ----------

class Telegram:
    def __init__(self, token):
        self.base = f"https://api.telegram.org/bot{token}/"

    def call(self, method, http_timeout=60, **params):
        try:
            resp = fleet.post_json(self.base + method, params, timeout=http_timeout)
        except Exception as e:
            raise RuntimeError(safe_err(e)) from None
        if not resp.get("ok"):
            raise RuntimeError(safe_err(resp))
        return resp.get("result")

    def send(self, chat_id, text, reply_kb=None):
        params = {"chat_id": chat_id, "text": text, "parse_mode": "HTML", "disable_web_page_preview": True}
        if reply_kb is not None:
            params["reply_markup"] = reply_kb
        return self.call("sendMessage", **params)

    def _post_file(self, method, field, path, chat_id, caption):
        boundary = "----tp" + uuid.uuid4().hex
        body = bytearray()
        fields = {"chat_id": str(chat_id)}
        if caption:
            fields["caption"] = caption
            fields["parse_mode"] = "HTML"
        for name, value in fields.items():
            body += (
                f"--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n"
            ).encode("utf-8")
        filename = Path(path).name
        mime = "image/png" if field == "photo" else (
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document")
        body += (
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"{field}\"; filename=\"{filename}\"\r\n"
            f"Content-Type: {mime}\r\n\r\n"
        ).encode("utf-8")
        body += Path(path).read_bytes()
        body += f"\r\n--{boundary}--\r\n".encode("utf-8")
        req = urllib.request.Request(self.base + method, data=bytes(body), method="POST")
        req.add_header("Content-Type", f"multipart/form-data; boundary={boundary}")
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                payload = json.loads(resp.read().decode("utf-8"))
        except Exception as e:
            raise RuntimeError(safe_err(e)) from None
        if not payload.get("ok"):
            raise RuntimeError(safe_err(payload))
        return payload.get("result")

    def send_document(self, chat_id, path, caption=None):
        return self._post_file("sendDocument", "document", path, chat_id, caption)

    def send_photo(self, chat_id, path, caption=None):
        return self._post_file("sendPhoto", "photo", path, chat_id, caption)


class Bot:
    def __init__(self, token):
        self.env = fleet.load_env()
        self.tg = Telegram(token)
        self.allowed = fleet.allowed_chats(self.env)

    def typing(self, chat_id, action="upload_document"):
        try:
            self.tg.call("sendChatAction", chat_id=chat_id, action=action)
        except Exception:
            pass

    def on_message(self, msg):
        chat_id = msg["chat"]["id"]
        text = (msg.get("text") or "").strip()
        if str(chat_id) not in self.allowed:
            self.tg.send(chat_id, f"⛔ Нет доступа.\nВаш ID: <code>{chat_id}</code> — передайте его администратору.")
            log(f"отказ в доступе: {chat_id}")
            return
        if not text:
            self.tg.send(chat_id, "Пришлите реквизиты текстом одним сообщением.\n\n" + HINT)
            return
        if text.startswith("/start") or text.lower() in ("помощь", "меню", "/help"):
            self.tg.send(chat_id, "📄 <b>Заявление на смену реквизитов</b>\n\n" + HINT)
            return
        self.typing(chat_id)
        data, problems = parse_message(text)
        if problems:
            body = "Не получилось заполнить заявление.\n\n" + "\n".join(f"• {fleet.esc(p)}" for p in problems)
            self.tg.send(chat_id, body + "\n\n" + HINT)
            log(f"не разобрал chat={chat_id}")
            return
        with tempfile.TemporaryDirectory(prefix="zayavlenie-") as tmp:
            docx, png = make_files(data, tmp)
            caption = summary_text(data)
            self.tg.send(chat_id, caption)
            self.tg.send_document(chat_id, docx, caption="Файл заявления")
            self.typing(chat_id, "upload_photo")
            self.tg.send_photo(chat_id, png, caption=caption[:1024])
        log(f"заявление {data['contract_line']} chat={chat_id}")

    def run(self):
        try:
            me = self.tg.call("getMe")
        except Exception as e:
            log("Telegram не принял токен DOCS_BOT_TOKEN.")
            log(safe_err(e))
            return 1
        try:
            self.tg.call("setMyCommands", commands=[
                {"command": "start", "description": "Как прислать реквизиты"},
            ])
        except Exception as e:
            log("не удалось записать команды: " + safe_err(e))
        who = ", ".join(sorted(self.allowed)) if self.allowed else "список пуст, всем отказ"
        log(f"бот @{me.get('username', '')} запущен, доступ: {who}")
        offset = None
        while True:
            try:
                params = {"timeout": 50, "allowed_updates": ["message"]}
                if offset is not None:
                    params["offset"] = offset
                updates = self.tg.call("getUpdates", http_timeout=70, **params)
            except Exception as e:
                log(f"ошибка связи с Telegram: {safe_err(e)}")
                time.sleep(5)
                continue
            for upd in updates:
                offset = upd["update_id"] + 1
                try:
                    if "message" in upd:
                        self.on_message(upd["message"])
                except Exception as e:
                    log("ошибка обработки:\n" + safe_err(traceback.format_exc()))
                    chat = (upd.get("message") or {}).get("chat", {})
                    if chat.get("id"):
                        try:
                            self.tg.send(chat["id"], f"❌ Ошибка: {fleet.esc(safe_err(e))[:500]}")
                        except Exception:
                            pass
        return 0


# ---------- проверка ----------

def _sample(**over):
    data = {
        "account": "40702810000000000009",
        "ks": "30101810000000000007",
        "bik": "044525104",
        "inn": "7700000009",
        "kpp": "",
        "ogrn": "",
        "name": "ООО Ромашка",
        "bank": 'ООО "Банк Тест"',
        "contracts": ["ОФ-12345678/25"],
        "contract_line": "ОФ-12345678/25",
        "notes": [],
        "date": "18.11.2026",
    }
    data.update(over)
    return data


def self_check():
    assert account_ok("044525104", "40702810000000000009")
    assert ks_ok("044525104", "30101810000000000007")
    assert inn_ok("7700000009")
    assert ogrn_ok("1234567890127")
    assert ogrn_ok("123456789012343")
    assert not account_ok("044525104", "40702810000000000000")
    assert not inn_ok("7700000000")
    assert not ogrn_ok("1234567890120")

    message = (
        "Расчётный счёт: 40702810000000000009\n"
        'Банк: ООО "Банк Тест"\n'
        "БИК: 044525104\n"
        "К/с: 30101810000000000007\n"
        "Наименование: ООО Ромашка\n"
        "ИНН: 7700000009\n"
        "КПП: 770001001\n"
        "Договор: ОФ-12345678-25\n"
    )
    data, problems = parse_message(message)
    assert not problems, problems
    assert data["account"] == "40702810000000000009"
    assert data["bank"] == 'ООО "Банк Тест"'
    assert data["contracts"] == ["ОФ-12345678/25"]
    assert data["kpp"] == "770001001"
    assert data["ogrn"] == ""
    assert any("ОГРН" in note and "пустое" in note for note in data["notes"])
    assert any("КПП" in note and "не ставил" in note for note in data["notes"])

    plain = "\n".join([
        "40802810000000000006",
        "ПАО Сбербанк",
        "044525104",
        "30101810000000000007",
        "Индивидуальный предприниматель Иванов Иван Иванович",
        "770000000000",
        "ОФ 42391680/25",
    ])
    # ИНН ниже подставим верный — здесь проверяем отказ по контрольной цифре.
    bad, problems = parse_message(plain)
    assert bad is None and any("ИНН" in p for p in problems), problems

    ip_inn = "770000000000"
    # 12-значный ИНН соберём тем же правилом, что проверяет бот, и подставим.
    digits = [int(ch) for ch in "7700000000"]
    n11 = sum(digits[i] * (7, 2, 4, 10, 3, 5, 9, 4, 6, 8)[i] for i in range(10)) % 11 % 10
    digits.append(n11)
    n12 = sum(digits[i] * (3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8)[i] for i in range(11)) % 11 % 10
    ip_inn = "7700000000" + str(n11) + str(n12)
    assert inn_ok(ip_inn)
    ip = "\n".join([
        "40802810000000000006",
        "ПАО Сбербанк",
        "044525104",
        "30101810000000000007",
        "Индивидуальный предприниматель Иванов Иван Иванович",
        ip_inn,
        "договор 72388964-26",
    ])
    data, problems = parse_message(ip)
    assert not problems, problems
    assert data["inn"] == ip_inn and data["ogrn"] == ""
    assert data["contracts"] == ["72388964/26"]
    assert data["name"].startswith("Индивидуальный предприниматель")
    assert "Сбербанк" in data["bank"]

    both = message + "ОГРН: 1234567890127\nЕщё договор 72076988/26\n"
    data, problems = parse_message(both)
    assert not problems, problems
    assert data["ogrn"] == "1234567890127"
    assert data["contracts"] == ["ОФ-12345678/25", "72076988/26"]
    assert data["contract_line"] == "ОФ-12345678/25, 72076988/26"
    assert not any("пустое" in note for note in data["notes"])

    absent, problems = parse_message(message + "ОГРН: нет\n")
    assert not problems and absent["ogrn"] == "", problems

    card = "\n".join([
        "Сч. № 40702810000000000009",
        'Банк получателя: ООО "Банк Тест"',
        "БИК 044525104",
        "Корр. сч. № 30101810000000000007",
        "Получатель: ООО Ромашка",
        "ИНН 7700000009",
        "ОГРН: нет",
        "ОФ-12345678/25",
    ])
    data, problems = parse_message(card)
    assert not problems, problems
    assert data["account"] == "40702810000000000009"
    assert data["ks"] == "30101810000000000007"
    assert data["bik"] == "044525104"
    assert data["name"] == "ООО Ромашка"
    assert data["bank"] == 'ООО "Банк Тест"'
    assert data["ogrn"] == ""
    assert any("пустое" in note for note in data["notes"])

    broken = message.replace("40702810000000000009", "40702810000000000000")
    refused, problems = parse_message(broken)
    assert refused is None and any("не сходится" in p for p in problems)

    with tempfile.TemporaryDirectory() as tmp:
        docx, png = make_files(_sample(kpp="770001001"), tmp)
        texts = document_texts(docx)
        joined = "\n".join(texts)
        assert "ООО Ромашка" in joined
        assert "7700000009" in joined
        assert "770001001" not in joined  # КПП в бланке нет
        assert "40702810000000000009" in joined
        assert "30101810000000000007" in joined
        assert 'ООО "Банк Тест"' in joined or "ООО &quot;Банк Тест&quot;" in joined
        assert "ОФ-12345678/25" in joined
        assert "18.11.2026" in joined
        assert "{{" not in joined
        # пустой ОГРН — метки нет и чужого номера нет
        assert "1234567890127" not in joined
        ogrn_at = texts.index("ОГРН")
        assert texts[ogrn_at + 1] == ""
        assert png.stat().st_size > 1000
        from PIL import Image
        assert Image.open(png).size == (1240, 1754)
        xml = zipfile.ZipFile(TEMPLATE).read("word/document.xml").decode("utf-8")
        assert "{{ACCOUNT}}" in xml and "{{OGRN}}" in xml
        assert not re.search(r"\d{13,}", xml)
    print("проверка заявлений прошла")
    return 0


def cmd_fill(argv):
    if "--fill" not in argv:
        return 1
    rest = argv[argv.index("--fill") + 1:]
    out = Path("zayavlenie-out")
    if "--out" in rest:
        pos = rest.index("--out")
        out = Path(rest[pos + 1])
        rest = rest[:pos] + rest[pos + 2:]
    message = " ".join(rest)
    if message.startswith("@") and Path(message[1:]).exists():
        message = Path(message[1:]).read_text(encoding="utf-8")
    data, problems = parse_message(message)
    if problems:
        print("Не получилось заполнить заявление.")
        for item in problems:
            print("• " + item)
        return 1
    try:
        docx, png = make_files(data, out)
    except RuntimeError as e:
        print(safe_err(e))
        return 1
    print(re.sub(r"<[^>]+>", "", summary_text(data)))
    print(docx)
    print(png)
    return 0


def main(argv):
    if "--check" in argv:
        return self_check()
    if "--fill" in argv:
        return cmd_fill(argv)
    token = token_from_env()
    if not token:
        print("DOCS_BOT_TOKEN не задан. Бот заявлений не запущен.")
        return 0
    try:
        import PIL  # noqa: F401
    except ImportError:
        print("Для картинки заявления нужен пакет pillow: pip install pillow")
        return 1
    return Bot(token).run()


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    sys.exit(main(sys.argv) or 0)
