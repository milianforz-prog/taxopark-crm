import { useEffect, useMemo, useState } from "react";
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Card, Chips, Empty, Kpi, Money, Pager, Spinner } from "../components/ui";
import { csvDownload, finKey, FIN_GROUPS, fmtDate, fmtDay, fullName, money, shortMoney } from "../lib/format";
import { useData } from "../lib/store";
import { fetchAll, supabase } from "../lib/supabase";

const PERIODS = [
  { value: "today", label: "Сегодня" },
  { value: "yesterday", label: "Вчера" },
  { value: "7", label: "7 дней" },
  { value: "30", label: "30 дней" },
  { value: "custom", label: "Период" },
];
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
const PAGE = 50;

function range(period, from, to) {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  if (period === "today") return [start, new Date()];
  if (period === "yesterday") return [new Date(start.getTime() - 86400000), start];
  if (period === "custom" && from && to) {
    const a = new Date(from + "T00:00:00");
    const b = new Date(to + "T00:00:00");
    return [a, new Date(b.getTime() + 86400000)];
  }
  const days = Number(period) || 7;
  return [new Date(start.getTime() - (days - 1) * 86400000), new Date()];
}

export default function Finance() {
  const { parkFilter, driverById, setOpenDriver, parkById } = useData();
  const [period, setPeriod] = useState("7");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [rows, setRows] = useState(null);
  const [opsKind, setOpsKind] = useState("topup");
  const [ops, setOps] = useState(null);
  const [page, setPage] = useState(0);

  const [a, b] = useMemo(() => range(period, from, to), [period, from, to]);
  const park = parkFilter === "all" ? null : parkFilter;

  useEffect(() => {
    setRows(null);
    supabase.rpc("finance_by_day", { p_from: a.toISOString(), p_to: b.toISOString(), p_park: park, p_tz: TZ })
      .then(({ data }) => setRows(data || []));
  }, [a, b, park]);

  useEffect(() => {
    setOps(null);
    setPage(0);
    const groups = opsKind === "all" ? null : FIN_GROUPS.find((g) => g.key === opsKind)?.groups;
    fetchAll(() => {
      let q = supabase.from("transactions").select("*")
        .gte("event_at", a.toISOString()).lt("event_at", b.toISOString()).order("event_at", { ascending: false });
      if (park) q = q.eq("park_id", park);
      if (groups) q = q.in("group_id", groups);
      return q;
    }).then(setOps).catch(() => setOps([]));
  }, [a, b, park, opsKind]);

  const totals = useMemo(() => {
    const t = Object.fromEntries(FIN_GROUPS.map((g) => [g.key, { sum: 0, cnt: 0 }]));
    for (const r of rows || []) {
      const k = finKey(r.group_id);
      if (t[k]) {
        t[k].sum += Number(r.amount);
        t[k].cnt += Number(r.cnt);
      }
    }
    return t;
  }, [rows]);

  const chart = useMemo(() => {
    const byDay = {};
    for (const r of rows || []) {
      const k = finKey(r.group_id);
      if (!["topup", "withdraw", "partner_fees", "partner_other"].includes(k)) continue;
      const d = (byDay[r.day] ||= { day: r.day, topup: 0, withdraw: 0, income: 0 });
      if (k === "topup") d.topup += Number(r.amount);
      else if (k === "withdraw") d.withdraw += Math.abs(Number(r.amount));
      else d.income += Math.abs(Number(r.amount));
    }
    return Object.values(byDay).sort((x, y) => x.day.localeCompare(y.day));
  }, [rows]);

  const categories = useMemo(() => {
    const m = {};
    for (const r of rows || []) {
      const c = (m[r.category_id] ||= { id: r.category_id, name: r.category_name, group: finKey(r.group_id), sum: 0, cnt: 0 });
      c.sum += Number(r.amount);
      c.cnt += Number(r.cnt);
    }
    return Object.values(m).sort((x, y) => Math.abs(y.sum) - Math.abs(x.sum));
  }, [rows]);

  const income = Math.abs(totals.partner_fees.sum) + Math.abs(totals.partner_other.sum);
  const pages = Math.ceil((ops?.length || 0) / PAGE);

  const exportOps = () =>
    csvDownload(`operacii_${opsKind}.csv`, ["Дата", "Водитель", "Парк", "Категория", "Сумма", "Описание"],
      (ops || []).map((t) => [fmtDate(t.event_at), driverName(driverById[t.driver_id]), parkById[t.park_id]?.name,
        t.category_name, t.amount, t.description]));

  return (
    <div className="page">
      <div className="toolbar">
        <div className="toolbar-group">
          <Chips value={period} onChange={setPeriod} options={PERIODS} />
          {period === "custom" && (
            <>
              <input className="input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
              <span className="muted">—</span>
              <input className="input" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
            </>
          )}
        </div>
      </div>

      {rows === null ? <Spinner /> : (
        <>
          <div className="kpis">
            <Kpi label="Пополнения" value={money(totals.topup.sum)} sub={`${totals.topup.cnt} операций`} tone="ok"
                 onClick={() => setOpsKind("topup")} />
            <Kpi label="Выводы" value={money(Math.abs(totals.withdraw.sum))} sub={`${totals.withdraw.cnt} операций`} tone="bad"
                 onClick={() => setOpsKind("withdraw")} />
            <Kpi label="Доход парка" value={money(income)} sub="комиссия + списания" tone="info" />
            <Kpi label="Комиссия парка" value={money(Math.abs(totals.partner_fees.sum))} sub={`${totals.partner_fees.cnt} операций`}
                 onClick={() => setOpsKind("partner_fees")} />
            <Kpi label="Списания парка" value={money(Math.abs(totals.partner_other.sum))} sub="аренда, штрафы, ручные"
                 onClick={() => setOpsKind("partner_other")} />
            <Kpi label="Безнал за поездки" value={money(totals.cashless.sum)} onClick={() => setOpsKind("cashless")} />
            <Kpi label="Наличные" value={money(totals.cash.sum)} onClick={() => setOpsKind("cash")} />
            <Kpi label="Комиссия Яндекса" value={money(Math.abs(totals.platform_fees.sum))} onClick={() => setOpsKind("platform_fees")} />
          </div>

          <div className="grid-2">
            <Card title="Пополнения, выводы и доход по дням">
              {chart.length === 0 ? <Empty>Операций за период нет</Empty> : (
                <ResponsiveContainer width="100%" height={260}>
                  <BarChart data={chart} margin={{ left: 4, right: 8, top: 8 }}>
                    <CartesianGrid strokeDasharray="3 3" className="grid-line" />
                    <XAxis dataKey="day" tickFormatter={fmtDay} fontSize={12} />
                    <YAxis tickFormatter={shortMoney} fontSize={12} width={56} />
                    <Tooltip formatter={(v) => money(v)} labelFormatter={fmtDay} />
                    <Legend />
                    <Bar dataKey="topup" name="Пополнения" fill="var(--ok)" radius={[4, 4, 0, 0]} />
                    <Bar dataKey="withdraw" name="Выводы" fill="var(--bad)" radius={[4, 4, 0, 0]} />
                    <Bar dataKey="income" name="Доход парка" fill="var(--accent)" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </Card>

            <Card title="По категориям">
              {categories.length === 0 ? <Empty>Нет данных</Empty> : (
                <div className="table-wrap scroll-y">
                  <table className="table compact">
                    <thead><tr><th>Категория</th><th className="num">Операций</th><th className="num">Сумма</th></tr></thead>
                    <tbody>
                      {categories.map((c) => (
                        <tr key={c.id}>
                          <td>{c.name}</td>
                          <td className="num muted">{c.cnt}</td>
                          <td className="num"><Money value={c.sum} sign /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          </div>
        </>
      )}

      <Card title="Операции" actions={
        <>
          <select className="input" value={opsKind} onChange={(e) => setOpsKind(e.target.value)}>
            {FIN_GROUPS.map((g) => <option key={g.key} value={g.key}>{g.label}</option>)}
            <option value="all">Все операции</option>
          </select>
          <button className="btn" onClick={exportOps} disabled={!ops?.length}>⬇ Excel</button>
        </>
      }>
        {ops === null ? <Spinner /> : ops.length === 0 ? <Empty>Операций нет</Empty> : (
          <>
            <div className="summary-line">
              <b>{ops.length}</b> операций на <Money value={ops.reduce((s, t) => s + Number(t.amount), 0)} sign />
            </div>
            <div className="table-wrap">
              <table className="table hover compact">
                <thead><tr><th>Дата</th><th>Водитель</th><th>Категория</th><th className="num">Сумма</th></tr></thead>
                <tbody>
                  {ops.slice(page * PAGE, page * PAGE + PAGE).map((t) => (
                    <tr key={t.id} onClick={() => t.driver_id && driverById[t.driver_id] && setOpenDriver(t.driver_id)}>
                      <td className="small nowrap">{fmtDate(t.event_at)}</td>
                      <td>{driverName(driverById[t.driver_id])}<div className="muted small">{parkById[t.park_id]?.name}</div></td>
                      <td className="small">{t.category_name}{t.description && <div className="muted">{t.description}</div>}</td>
                      <td className="num"><Money value={t.amount} sign /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pager page={page} pages={pages} setPage={setPage} />
          </>
        )}
      </Card>
    </div>
  );
}

function driverName(d) {
  return d ? fullName(d) : <span className="muted">—</span>;
}
