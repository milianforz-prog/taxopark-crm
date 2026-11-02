const moneyFmt = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 });

export function money(x, { sign = false } = {}) {
  const v = Number(x) || 0;
  const s = moneyFmt.format(Math.abs(v));
  if (v < 0) return `−${s} ₽`;
  return `${sign && v > 0 ? "+" : ""}${s} ₽`;
}

export function shortMoney(x) {
  const v = Math.abs(Number(x) || 0);
  const s = v >= 1e6 ? `${(v / 1e6).toFixed(1)} млн` : v >= 1000 ? `${Math.round(v / 1000)} тыс` : `${Math.round(v)}`;
  return (x < 0 ? "−" : "") + s;
}

export function fullName(d, middle = false) {
  return [d.last_name, d.first_name, middle ? d.middle_name : null].filter(Boolean).join(" ") || "Без имени";
}

export function fmtDate(v, withTime = true) {
  if (!v) return "—";
  const d = new Date(v);
  return d.toLocaleString("ru-RU", withTime
    ? { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }
    : { day: "2-digit", month: "2-digit", year: "numeric" });
}

export function fmtDay(v) {
  if (!v) return "—";
  return new Date(v + (v.length === 10 ? "T00:00:00" : "")).toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" });
}

export function ago(v) {
  if (!v) return "";
  const sec = (Date.now() - new Date(v).getTime()) / 1000;
  if (sec < 3600) return `${Math.max(1, Math.floor(sec / 60))} мин`;
  if (sec < 86400) return `${Math.floor(sec / 3600)} ч`;
  return `${Math.floor(sec / 86400)} дн`;
}

export function daysSince(v) {
  if (!v) return null;
  return Math.floor((Date.now() - new Date(v).getTime()) / 86400000);
}

export const WORK_STATUS = {
  working: { label: "Работает", tone: "ok" },
  not_working: { label: "Не работает", tone: "warn" },
  fired: { label: "Уволен", tone: "muted" },
};

export const CURRENT_STATUS = {
  free: { label: "Свободен", tone: "ok" },
  in_order: { label: "На заказе", tone: "info" },
  busy: { label: "Занят", tone: "warn" },
  offline: { label: "Офлайн", tone: "muted" },
};
export const ONLINE = new Set(["free", "in_order", "busy"]);

export const CRM_STATUS = {
  new: { label: "Новый", tone: "muted" },
  contacted: { label: "Связались", tone: "info" },
  promised: { label: "Обещал оплатить", tone: "warn" },
  no_answer: { label: "Не отвечает", tone: "bad" },
  refused: { label: "Отказ", tone: "bad" },
  legal: { label: "Претензия / суд", tone: "bad" },
  closed: { label: "Закрыт", tone: "ok" },
};

export const NOTE_KIND = {
  comment: "💬 Комментарий",
  call: "📞 Звонок",
  promise: "🤝 Обещание",
  payment: "💰 Оплата",
  status: "🔖 Статус",
};

// Группы транзакций Fleet API → понятные разделы финансов
export const FIN_GROUPS = [
  { key: "topup", label: "Пополнения", groups: ["contractor_balance_topup"], tone: "ok" },
  { key: "withdraw", label: "Выводы", groups: ["contractor_balance_withdraw"], tone: "bad", abs: true },
  { key: "partner_fees", label: "Комиссия парка", groups: ["partner_fees"], tone: "info", abs: true },
  { key: "partner_other", label: "Списания парка", hint: "аренда, штрафы, ручные", groups: ["partner_other"], tone: "info", abs: true },
  { key: "cashless", label: "Безнал за поездки", groups: ["platform_card", "platform_corporate", "platform_tip", "platform_promotion", "platform_bonus", "partner_rides"], tone: "ok" },
  { key: "cash", label: "Наличные", groups: ["cash_collected"], tone: "muted" },
  { key: "platform_fees", label: "Комиссия Яндекса", groups: ["platform_fees"], tone: "muted", abs: true },
  { key: "taxes", label: "Налоги и сборы", groups: ["mandatory_taxes_fee"], tone: "muted", abs: true },
];
const GROUP_TO_FIN = Object.fromEntries(FIN_GROUPS.flatMap((g) => g.groups.map((id) => [id, g.key])));
export const finKey = (groupId) => GROUP_TO_FIN[groupId] || "other";

export function csvDownload(filename, header, rows) {
  const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const text = "﻿" + [header, ...rows].map((r) => r.map(esc).join(";")).join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}
