// Telegram-бот для водителей (webhook). Вход по номеру телефона → личный кабинет → покупка смены.
// Смена — разовое списание цены смены водителя (цену ставит сотрудник в CRM) с баланса в Яндекс Про.
// Отключить смену можно не раньше чем через 6 дней после покупки.
import { createClient } from "jsr:@supabase/supabase-js@2";

const FLEET = "https://fleet-api.taxi.yandex.net";
const MIN_DAYS = 6;
const TZ = "Europe/Moscow";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});

type Park = { id: string; name: string; fleet_park_id: string; client_id: string; api_key: string };
type Driver = {
  id: string; park_id: string; last_name: string | null; first_name: string | null; middle_name: string | null;
  phone: string | null; work_status: string | null; current_status: string | null; balance: number;
  car: string | null; car_number: string | null;
};
type Shift = { id: string; price: number; status: string; started_at: string; min_end_at: string };
type Btn = { text: string; callback_data: string };

let settings: { token: string; webhook_secret: string } | null = null;

// ---------- Telegram ----------

async function tg(method: string, params: Record<string, unknown>) {
  const res = await fetch(`https://api.telegram.org/bot${settings!.token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  const data = await res.json();
  if (!data.ok && !String(data.description).includes("message is not modified")) {
    console.error(`telegram ${method}:`, data.description);
  }
  return data;
}

const send = (chat: number, text: string, markup?: unknown) =>
  tg("sendMessage", { chat_id: chat, text, parse_mode: "HTML", disable_web_page_preview: true, reply_markup: markup });

const edit = (chat: number, msg: number, text: string, kb: Btn[][]) =>
  tg("editMessageText", {
    chat_id: chat, message_id: msg, text, parse_mode: "HTML", disable_web_page_preview: true,
    reply_markup: { inline_keyboard: kb },
  });

const answer = (id: string, text = "", alert = false) =>
  tg("answerCallbackQuery", { callback_query_id: id, text, show_alert: alert });

const btn = (text: string, data: string): Btn => ({ text, callback_data: data });

const BTN_CABINET = "👤 Личный кабинет";
const BTN_LOGOUT = "🚪 Выйти";
const MAIN_KB = { keyboard: [[{ text: BTN_CABINET }], [{ text: BTN_LOGOUT }]], resize_keyboard: true, is_persistent: true };
const PHONE_KB = {
  keyboard: [[{ text: "📱 Отправить номер телефона", request_contact: true }]],
  resize_keyboard: true, one_time_keyboard: true,
};

// ---------- оформление ----------

const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const money = (x: number) => (x < 0 ? "−" : "") + Math.abs(Math.round(x)).toLocaleString("ru-RU").replace(/,/g, " ") + " ₽";
const fmt = (iso: string) =>
  new Intl.DateTimeFormat("ru-RU", { timeZone: TZ, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })
    .format(new Date(iso)).replace(",", "");
const fullName = (d: Driver) => [d.last_name, d.first_name, d.middle_name].filter(Boolean).join(" ") || "Водитель";
const STATUS: Record<string, string> = { free: "🟢 свободен", busy: "🟡 занят", in_order: "🚖 на заказе", offline: "⚫ офлайн" };

// ---------- данные ----------

async function parks(): Promise<Record<string, Park>> {
  const { data, error } = await sb.rpc("sync_get_parks");
  if (error) throw error;
  return Object.fromEntries((data as Park[]).map((p) => [p.id, p]));
}

async function fleet(park: Park, path: string, body: unknown, extra: Record<string, string> = {}) {
  const res = await fetch(FLEET + path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json", "Accept-Language": "ru",
      "X-Client-ID": park.client_id, "X-API-Key": park.api_key, "X-Park-ID": park.fleet_park_id, ...extra,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Fleet HTTP ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

// свежие баланс и статус прямо из Яндекса (в базе они обновляются раз в 10 минут)
async function refresh(park: Park, d: Driver): Promise<Driver> {
  try {
    const resp = await fleet(park, "/v1/parks/driver-profiles/list", {
      query: { park: { id: park.fleet_park_id, driver_profile: { id: [d.id] } } },
      fields: { account: ["balance"], driver_profile: ["id", "work_status"], current_status: ["status"] },
      limit: 1,
    });
    const item = resp.driver_profiles?.[0];
    if (!item) return d;
    const fresh = {
      ...d,
      balance: Number(item.accounts?.[0]?.balance ?? d.balance),
      work_status: item.driver_profile?.work_status ?? d.work_status,
      current_status: item.current_status?.status ?? d.current_status,
    };
    await sb.from("drivers").update({ balance: fresh.balance, work_status: fresh.work_status,
      current_status: fresh.current_status }).eq("id", d.id);
    return fresh;
  } catch (e) {
    console.error("refresh:", e);
    return d;
  }
}

async function linkedDriver(tgId: number): Promise<Driver | null> {
  const { data: link } = await sb.from("driver_telegram").select("driver_id, phone").eq("telegram_id", tgId).maybeSingle();
  if (!link) return null;
  const { data: d } = await sb.from("drivers").select("*").eq("id", link.driver_id).maybeSingle();
  const digits = (s: string | null) => (s || "").replace(/\D/g, "").slice(-10);
  if (!d || d.work_status === "fired" || digits(d.phone) !== digits(link.phone)) {
    await sb.from("driver_telegram").delete().eq("telegram_id", tgId);
    return null;
  }
  return { ...d, balance: Number(d.balance) };
}

async function activeShift(driverId: string): Promise<Shift | null> {
  const { data } = await sb.from("shifts").select("*").eq("driver_id", driverId).eq("status", "active").maybeSingle();
  return data ? { ...data, price: Number(data.price) } : null;
}

async function shiftPrice(driverId: string): Promise<number | null> {
  const { data } = await sb.from("shift_prices").select("price").eq("driver_id", driverId).maybeSingle();
  return data ? Number(data.price) : null;
}

// ---------- экраны ----------

async function cabinet(park: Park, d: Driver): Promise<[string, Btn[][]]> {
  const [shift, price] = await Promise.all([activeShift(d.id), shiftPrice(d.id)]);
  const lines = [
    `👤 <b>${esc(fullName(d))}</b>`,
    `🏢 ${esc(park.name)}`,
    "",
    `${d.balance < 0 ? "🔴" : "🟢"} Баланс: <b>${money(d.balance)}</b>`,
    `🚗 ${esc([d.car, d.car_number].filter(Boolean).join(" · ") || "—")}`,
    `📍 Сейчас: ${STATUS[d.current_status || "offline"] || STATUS.offline}`,
    "",
  ];
  const kb: Btn[][] = [];
  if (shift) {
    const days = Math.floor((Date.now() - Date.parse(shift.started_at)) / 86400_000) + 1;
    lines.push(`🕐 <b>Смена активна</b> · оплачено ${money(shift.price)}`);
    lines.push(`📅 С ${fmt(shift.started_at)} · ${days}-й день`);
    lines.push(Date.now() >= Date.parse(shift.min_end_at)
      ? "✅ Смену можно отключить"
      : `🔒 Отключить можно с <b>${fmt(shift.min_end_at)}</b>`);
    kb.push([btn("⛔ Отключить смену", "X")]);
  } else {
    lines.push("🕐 Смена не подключена");
    lines.push(price ? `💳 Стоимость смены: <b>${money(price)}</b>` : "💳 Стоимость смены не назначена — спросите диспетчера");
    if (price) kb.push([btn(`🛒 Купить смену · ${money(price)}`, "B")]);
  }
  kb.push([btn("🔄 Обновить", "R")]);
  return [lines.join("\n"), kb];
}

// ---------- обработка ----------

async function askPhone(chat: number) {
  await send(chat,
    "👋 <b>Здравствуйте!</b>\n\nЭто бот водителей таксопарка. Чтобы войти в личный кабинет, нажмите кнопку ниже " +
    "и отправьте свой номер телефона — тот, что указан в парке.", PHONE_KB);
}

async function onMessage(msg: any) {
  if (msg.chat?.type !== "private") return;
  const chat = msg.chat.id as number;
  const tgId = msg.from.id as number;

  if (msg.contact) {
    if (msg.contact.user_id !== tgId) {
      await send(chat, "⛔ Отправьте <b>свой</b> номер кнопкой «📱 Отправить номер телефона».", PHONE_KB);
      return;
    }
    const phone = String(msg.contact.phone_number || "");
    const { data } = await sb.rpc("driver_bot_find", { p_phone: phone });
    const found = ((data || []) as Driver[]).sort((a, b) =>
      Number(b.work_status === "working") - Number(a.work_status === "working"));
    if (!found.length) {
      console.log("вход не удался:", tgId);
      await send(chat, `😔 Номер <b>${esc(phone)}</b> не найден среди водителей парка.\n\n` +
        "Проверьте, что в Telegram тот же номер, что в Яндекс Про, или обратитесь к диспетчеру.", PHONE_KB);
      return;
    }
    const d = { ...found[0], balance: Number(found[0].balance) };
    await sb.from("driver_telegram").upsert({ telegram_id: tgId, driver_id: d.id, phone, linked_at: new Date().toISOString() });
    console.log("вход:", tgId, d.id);
    await send(chat, `✅ Добро пожаловать, <b>${esc(d.first_name || fullName(d))}</b>!`, MAIN_KB);
    const park = (await parks())[d.park_id];
    const [text, kb] = await cabinet(park, await refresh(park, d));
    await send(chat, text, { inline_keyboard: kb });
    return;
  }

  const d = await linkedDriver(tgId);
  if (!d) return askPhone(chat);
  if (msg.text === BTN_LOGOUT) {
    await sb.from("driver_telegram").delete().eq("telegram_id", tgId);
    await send(chat, "👋 Вы вышли из кабинета.", { remove_keyboard: true });
    return askPhone(chat);
  }
  const park = (await parks())[d.park_id];
  if (!park) return send(chat, "Парк временно недоступен. Обратитесь к диспетчеру.");
  if (msg.text === "/start") await send(chat, "Главное меню 👇", MAIN_KB);
  const [text, kb] = await cabinet(park, await refresh(park, d));
  await send(chat, text, { inline_keyboard: kb });
}

async function onCallback(cq: any) {
  const chat = cq.message.chat.id as number;
  const msgId = cq.message.message_id as number;
  const data = String(cq.data || "");
  let d = await linkedDriver(cq.from.id);
  if (!d) {
    await answer(cq.id, "Войдите заново");
    return askPhone(chat);
  }
  const park = (await parks())[d.park_id];
  if (!park) return answer(cq.id, "Парк недоступен");

  if (data === "R") {
    await answer(cq.id, "🔄 Обновляю…");
    d = await refresh(park, d);
    const [text, kb] = await cabinet(park, d);
    return edit(chat, msgId, text, kb);
  }

  if (data === "B") { // подтверждение покупки
    const price = await shiftPrice(d.id);
    await answer(cq.id);
    if (!price) return edit(chat, msgId, "💳 Стоимость смены не назначена — спросите диспетчера.", [[btn("⬅️ Назад", "R")]]);
    d = await refresh(park, d);
    const until = new Date(Date.now() + MIN_DAYS * 86400_000).toISOString();
    return edit(chat, msgId,
      `🛒 <b>Купить смену за ${money(price)}?</b>\n\n` +
      `💰 Баланс сейчас: ${money(d.balance)} → после покупки ${money(d.balance - price)}\n` +
      `🔒 Отключить смену можно будет не раньше чем через <b>${MIN_DAYS} дней</b> — с ${fmt(until)}.`,
      [[btn("✅ Купить", "Y"), btn("❌ Отмена", "R")]]);
  }

  if (data === "Y") return buy(cq, park, d);

  if (data === "X") { // отключение — сначала проверяем 6 дней
    const shift = await activeShift(d.id);
    if (!shift) {
      await answer(cq.id, "Смена не подключена");
    } else if (Date.now() < Date.parse(shift.min_end_at)) {
      return answer(cq.id, `🔒 Отключить смену можно только через ${MIN_DAYS} дней после покупки — с ${fmt(shift.min_end_at)}`, true);
    } else {
      await answer(cq.id);
      return edit(chat, msgId, "⛔ <b>Отключить смену?</b>\n\nДеньги за смену не возвращаются.",
        [[btn("✅ Отключить", "XY"), btn("❌ Отмена", "R")]]);
    }
    const [text, kb] = await cabinet(park, d);
    return edit(chat, msgId, text, kb);
  }

  if (data === "XY") {
    const shift = await activeShift(d.id);
    if (shift && Date.now() < Date.parse(shift.min_end_at)) {
      return answer(cq.id, `🔒 Отключить можно с ${fmt(shift.min_end_at)}`, true);
    }
    if (shift) {
      await sb.from("shifts").update({ status: "ended", ended_at: new Date().toISOString() }).eq("id", shift.id);
      console.log("смена отключена:", d.id);
    }
    await answer(cq.id, "Смена отключена");
    const [text, kb] = await cabinet(park, d);
    return edit(chat, msgId, "✅ <b>Смена отключена.</b>\n\n" + text, kb);
  }

  await answer(cq.id);
}

async function buy(cq: any, park: Park, d: Driver) {
  const chat = cq.message.chat.id as number;
  const msgId = cq.message.message_id as number;
  const price = await shiftPrice(d.id);
  if (!price) return answer(cq.id, "Стоимость смены не назначена", true);
  if (await activeShift(d.id)) {
    await answer(cq.id, "Смена уже подключена");
    const [text, kb] = await cabinet(park, d);
    return edit(chat, msgId, text, kb);
  }
  d = await refresh(park, d);
  if (d.balance < price) {
    return answer(cq.id, `Недостаточно средств: на балансе ${money(d.balance)}, смена стоит ${money(price)}. Пополните баланс.`, true);
  }

  // сначала запись в базе (уникальный индекс не даст купить две смены одновременно), потом списание
  const now = new Date();
  const { data: shift, error } = await sb.from("shifts").insert({
    driver_id: d.id, park_id: park.id, price, status: "pending", telegram_id: cq.from.id,
    started_at: now.toISOString(), min_end_at: new Date(now.getTime() + MIN_DAYS * 86400_000).toISOString(),
  }).select().single();
  if (error) return answer(cq.id, "Покупка уже обрабатывается…");
  await answer(cq.id, "⏳ Покупаю смену…");

  try {
    await fleet(park, "/v2/parks/driver-profiles/transactions", {
      park_id: park.fleet_park_id,
      driver_profile_id: d.id,
      amount: (-price).toFixed(2),
      category_id: "partner_service_manual",
      description: `Покупка смены (бот), ${fmt(now.toISOString())}`,
    }, { "X-Idempotency-Token": shift.id.replace(/-/g, "") });
  } catch (e) {
    console.error("списание не прошло:", e);
    await sb.from("shifts").update({ status: "failed", error: String(e).slice(0, 500) }).eq("id", shift.id);
    return edit(chat, msgId, "❌ Не удалось оплатить смену. Попробуйте позже или обратитесь к диспетчеру.",
      [[btn("⬅️ В кабинет", "R")]]);
  }
  await sb.from("shifts").update({ status: "active" }).eq("id", shift.id);
  console.log("смена куплена:", d.id, price);
  d = { ...d, balance: d.balance - price };
  await sb.from("drivers").update({ balance: d.balance }).eq("id", d.id);
  const [text, kb] = await cabinet(park, d);
  return edit(chat, msgId, "✅ <b>Смена куплена!</b>\n\n" + text, kb);
}

Deno.serve(async (req) => {
  if (!settings) {
    const { data, error } = await sb.rpc("driver_bot_settings").single();
    if (error || !data) return new Response("not configured", { status: 500 });
    settings = data as { token: string; webhook_secret: string };
  }
  if (req.headers.get("x-telegram-bot-api-secret-token") !== settings.webhook_secret) {
    return new Response("forbidden", { status: 403 });
  }
  try {
    const update = await req.json();
    if (update.callback_query) await onCallback(update.callback_query);
    else if (update.message) await onMessage(update.message);
  } catch (e) {
    console.error("ошибка обработки:", e);
  }
  return new Response("ok");
});
