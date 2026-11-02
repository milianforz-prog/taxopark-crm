import { useEffect } from "react";
import { money } from "../lib/format";

export function Badge({ tone = "muted", children, title }) {
  return <span className={`badge badge-${tone}`} title={title}>{children}</span>;
}

export function Kpi({ label, value, sub, tone, onClick }) {
  return (
    <div className={`kpi ${onClick ? "clickable" : ""}`} onClick={onClick}>
      <div className="kpi-label">{label}</div>
      <div className={`kpi-value ${tone ? "tone-" + tone : ""}`}>{value}</div>
      {sub && <div className="kpi-sub">{sub}</div>}
    </div>
  );
}

export function Card({ title, actions, children, className = "" }) {
  return (
    <section className={`card ${className}`}>
      {(title || actions) && (
        <header className="card-head">
          <h2>{title}</h2>
          {actions && <div className="card-actions">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

export function Money({ value, sign }) {
  const v = Number(value) || 0;
  return <span className={`money ${v < 0 ? "neg" : v > 0 ? "pos" : ""}`}>{money(v, { sign })}</span>;
}

export function Delta({ value }) {
  if (value === null || value === undefined || Number.isNaN(value)) return <span className="muted">—</span>;
  if (Math.abs(value) < 1) return <span className="muted">0</span>;
  return <span className={`delta ${value < 0 ? "neg" : "pos"}`}>{value < 0 ? "▼" : "▲"} {money(Math.abs(value))}</span>;
}

export function Empty({ children }) {
  return <div className="empty">{children}</div>;
}

export function Spinner({ label = "Загрузка…" }) {
  return <div className="spinner"><span className="spin" />{label}</div>;
}

export function Chips({ options, value, onChange }) {
  return (
    <div className="chips">
      {options.map((o) => (
        <button key={o.value} className={`chip ${o.value === value ? "active" : ""}`} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Drawer({ open, onClose, children }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()}>
        <button className="drawer-close" onClick={onClose} aria-label="Закрыть">✕</button>
        {children}
      </aside>
    </div>
  );
}

export function SortHeader({ label, field, sort, setSort, className = "" }) {
  const active = sort.field === field;
  return (
    <th className={`sortable ${className} ${active ? "active" : ""}`}
        onClick={() => setSort({ field, dir: active && sort.dir === "asc" ? "desc" : "asc" })}>
      {label}{active ? (sort.dir === "asc" ? " ↑" : " ↓") : ""}
    </th>
  );
}

export function sortRows(rows, sort, getters = {}) {
  const get = getters[sort.field] || ((r) => r[sort.field]);
  const dir = sort.dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const x = get(a), y = get(b);
    if (x == null && y == null) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    return (typeof x === "string" ? x.localeCompare(y, "ru") : x - y) * dir;
  });
}

export function Pager({ page, pages, setPage }) {
  if (pages <= 1) return null;
  return (
    <div className="pager">
      <button disabled={page === 0} onClick={() => setPage(page - 1)}>←</button>
      <span>{page + 1} / {pages}</span>
      <button disabled={page >= pages - 1} onClick={() => setPage(page + 1)}>→</button>
    </div>
  );
}
