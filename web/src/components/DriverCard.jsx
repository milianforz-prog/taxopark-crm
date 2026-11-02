import { useCallback, useEffect, useState } from "react";
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { ago, CRM_STATUS, CURRENT_STATUS, fmtDate, fmtDay, fullName, money, NOTE_KIND, ONLINE, shortMoney, WORK_STATUS } from "../lib/format";
import { useData } from "../lib/store";
import { supabase } from "../lib/supabase";
import { Badge, Drawer, Empty, Money, Plate, Spinner } from "./ui";

export default function DriverCard() {
  const { openDriver, setOpenDriver, driverById, reload } = useData();
  const d = openDriver ? driverById[openDriver] : null;
  const close = useCallback(() => setOpenDriver(null), [setOpenDriver]);
  return (
    <Drawer open={!!openDriver} onClose={close}>
      {d ? <CardBody key={d.id} d={d} reload={reload} /> : <Spinner />}
    </Drawer>
  );
}

function CardBody({ d, reload }) {
  const [tab, setTab] = useState("crm");
  const [history, setHistory] = useState(null);
  const [tx, setTx] = useState(null);
  const [notes, setNotes] = useState(null);

  const loadNotes = useCallback(async () => {
    const { data } = await supabase.from("driver_notes").select("*").eq("driver_id", d.id).order("created_at", { ascending: false });
    setNotes(data || []);
  }, [d.id]);

  useEffect(() => {
    loadNotes();
    supabase.from("balance_snapshots").select("day,balance").eq("driver_id", d.id).order("day").limit(120)
      .then(({ data }) => setHistory((data || []).map((r) => ({ ...r, balance: Number(r.balance) }))));
    supabase.from("transactions").select("*").eq("driver_id", d.id).order("event_at", { ascending: false }).limit(200)
      .then(({ data }) => setTx(data || []));
  }, [d.id, loadNotes]);

  const cs = CURRENT_STATUS[d.current_status] || CURRENT_STATUS.offline;
  const ws = WORK_STATUS[d.work_status];
  const online = ONLINE.has(d.current_status);

  return (
    <div className="driver-card">
      <header className="dc-head">
        <div>
          <h2>{fullName(d, true)}</h2>
          <div className="muted">{d.park_name}</div>
          <div className="dc-badges">
            <Badge tone={cs.tone}>{cs.label}</Badge>
            {ws && <Badge tone={ws.tone}>{ws.label}</Badge>}
          </div>
        </div>
        <div className="dc-balance">
          <div className="muted small">Баланс</div>
          <Money value={d.balance} />
        </div>
      </header>

      <div className="dc-facts">
        <Fact label="Телефон" value={d.phone ? <a href={`tel:${d.phone}`}>{d.phone}</a> : "—"} />
        <Fact label="Автомобиль" value={d.car || d.car_number ? <span className="car-cell"><Plate number={d.car_number} />{d.car}</span> : "—"} />
        <Fact label={online ? "На линии с" : "Последний раз на линии"}
              value={d.status_updated_at ? `${fmtDate(d.status_updated_at)} (${ago(d.status_updated_at)} назад)` : "—"} />
        <Fact label="Последняя операция" value={fmtDate(d.last_transaction_at)} />
        <Fact label="Принят" value={fmtDate(d.hire_date, false)} />
        <Fact label="Данные обновлены" value={`${ago(d.updated_at)} назад`} />
      </div>

      <nav className="tabs">
        <button className={tab === "crm" ? "active" : ""} onClick={() => setTab("crm")}>Работа с долгом</button>
        <button className={tab === "history" ? "active" : ""} onClick={() => setTab("history")}>Баланс</button>
        <button className={tab === "tx" ? "active" : ""} onClick={() => setTab("tx")}>Операции</button>
      </nav>

      {tab === "crm" && <CrmTab d={d} notes={notes} onChanged={() => { loadNotes(); reload(); }} />}
      {tab === "history" && (
        history === null ? <Spinner /> : history.length < 2 ? <Empty>История баланса копится ежедневно — график появится через пару дней.</Empty> : (
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={history} margin={{ left: 4, right: 12, top: 12 }}>
              <CartesianGrid strokeDasharray="3 3" className="grid-line" />
              <XAxis dataKey="day" tickFormatter={fmtDay} fontSize={12} />
              <YAxis tickFormatter={shortMoney} fontSize={12} width={56} />
              <ReferenceLine y={0} stroke="var(--muted)" />
              <Tooltip formatter={(v) => money(v)} labelFormatter={fmtDay} />
              <Line dataKey="balance" name="Баланс" stroke="var(--accent)" dot={false} strokeWidth={2} />
            </LineChart>
          </ResponsiveContainer>
        )
      )}
      {tab === "tx" && (
        tx === null ? <Spinner /> : tx.length === 0 ? <Empty>Операций за период синхронизации нет</Empty> : (
          <ul className="tx-list">
            {tx.map((t) => (
              <li key={t.id}>
                <div>
                  <div>{t.category_name}</div>
                  <div className="muted small">{fmtDate(t.event_at)}{t.description ? ` · ${t.description}` : ""}</div>
                </div>
                <Money value={t.amount} sign />
              </li>
            ))}
          </ul>
        )
      )}
    </div>
  );
}

function Fact({ label, value }) {
  return <div className="fact"><div className="muted small">{label}</div><div>{value}</div></div>;
}

function CrmTab({ d, notes, onChanged }) {
  const [status, setStatus] = useState(d.crm_status || "new");
  const [promiseDate, setPromiseDate] = useState(d.promise_date || "");
  const [promiseAmount, setPromiseAmount] = useState(d.promise_amount ?? "");
  const [text, setText] = useState("");
  const [kind, setKind] = useState("call");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const dirty = status !== (d.crm_status || "new") || promiseDate !== (d.promise_date || "")
    || String(promiseAmount) !== String(d.promise_amount ?? "");

  const save = async () => {
    setBusy(true);
    setErr("");
    const { error } = await supabase.from("driver_crm").upsert({
      driver_id: d.id,
      status,
      promise_date: promiseDate || null,
      promise_amount: promiseAmount === "" ? null : Number(promiseAmount),
    });
    if (!error) {
      const parts = [`Статус: ${CRM_STATUS[status].label}`];
      if (promiseDate) parts.push(`обещал до ${fmtDate(promiseDate, false)}${promiseAmount ? ` — ${money(promiseAmount)}` : ""}`);
      await supabase.from("driver_notes").insert({ driver_id: d.id, kind: promiseDate ? "promise" : "status", text: parts.join(", ") });
      onChanged();
    } else setErr(error.message);
    setBusy(false);
  };

  const addNote = async (e) => {
    e.preventDefault();
    if (!text.trim()) return;
    setBusy(true);
    const { error } = await supabase.from("driver_notes").insert({ driver_id: d.id, kind, text: text.trim() });
    if (error) setErr(error.message);
    else {
      setText("");
      onChanged();
    }
    setBusy(false);
  };

  const remove = async (id) => {
    if (!confirm("Удалить запись?")) return;
    await supabase.from("driver_notes").delete().eq("id", id);
    onChanged();
  };

  return (
    <div className="crm">
      <div className="crm-form">
        <label>Статус
          <select className="input" value={status} onChange={(e) => setStatus(e.target.value)}>
            {Object.entries(CRM_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
        </label>
        <label>Обещал оплатить до
          <input className="input" type="date" value={promiseDate} onChange={(e) => setPromiseDate(e.target.value)} />
        </label>
        <label>Сумма
          <input className="input" type="number" min="0" placeholder={String(Math.abs(Math.round(d.balance)))}
                 value={promiseAmount} onChange={(e) => setPromiseAmount(e.target.value)} />
        </label>
        <button className="btn primary" disabled={!dirty || busy} onClick={save}>Сохранить</button>
      </div>

      <form className="note-form" onSubmit={addNote}>
        <select className="input" value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="call">📞 Звонок</option>
          <option value="comment">💬 Комментарий</option>
          <option value="payment">💰 Оплата</option>
        </select>
        <input className="input grow" placeholder="Например: дозвонился, обещал внести в пятницу"
               value={text} onChange={(e) => setText(e.target.value)} />
        <button className="btn primary" disabled={busy || !text.trim()}>Добавить</button>
      </form>
      {err && <div className="error">{err}</div>}

      {notes === null ? <Spinner /> : notes.length === 0 ? <Empty>Записей пока нет</Empty> : (
        <ul className="timeline">
          {notes.map((n) => (
            <li key={n.id}>
              <div className="tl-head">
                <span>{NOTE_KIND[n.kind] || n.kind}</span>
                <span className="muted small">{n.author_name || "—"} · {fmtDate(n.created_at)}</span>
                <button className="link small" onClick={() => remove(n.id)}>удалить</button>
              </div>
              <div>{n.text}</div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
