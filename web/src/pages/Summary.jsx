import { useEffect, useMemo, useState } from "react";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Badge, Card, Empty, Kpi, Money } from "../components/ui";
import { ago, finKey, fmtDay, fullName, money, ONLINE, shortMoney, WORK_STATUS } from "../lib/format";
import { useData } from "../lib/store";
import { supabase } from "../lib/supabase";

export default function Summary({ go }) {
  const { parks, visibleDrivers, parkFilter, setOpenDriver } = useData();
  const [history, setHistory] = useState([]);
  const [fin, setFin] = useState(null);

  const shownParks = parkFilter === "all" ? parks : parks.filter((p) => p.id === parkFilter);

  useEffect(() => {
    const since = new Date(Date.now() - 60 * 86400000).toISOString().slice(0, 10);
    let q = supabase.from("daily_balance").select("*").gte("day", since).order("day");
    if (parkFilter !== "all") q = q.eq("park_id", parkFilter);
    q.then(({ data }) => {
      const byDay = {};
      for (const r of data || []) {
        const d = (byDay[r.day] ||= { day: r.day, minus: 0, debtors: 0 });
        d.minus += Number(r.minus_sum);
        d.debtors += r.debtors_5000;
      }
      setHistory(Object.values(byDay));
    });
    const from = new Date(Date.now() - 7 * 86400000).toISOString();
    supabase.rpc("finance_by_day", {
      p_from: from, p_to: new Date().toISOString(),
      p_park: parkFilter === "all" ? null : parkFilter,
      p_tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    }).then(({ data }) => {
      const t = { topup: 0, withdraw: 0, partner_fees: 0, partner_other: 0 };
      for (const r of data || []) {
        const k = finKey(r.group_id);
        if (k in t) t[k] += Number(r.amount);
      }
      setFin(t);
    });
  }, [parkFilter]);

  const totals = useMemo(() => {
    const t = { drivers: 0, working: 0, online: 0, plus: 0, minus: 0, minusCount: 0 };
    for (const p of shownParks) {
      t.drivers += p.drivers_total;
      t.working += p.drivers_working;
      t.online += p.online;
      t.plus += Number(p.plus_sum);
      t.minus += Number(p.minus_sum);
      t.minusCount += p.minus_count;
    }
    return t;
  }, [shownParks]);

  const debtors = useMemo(
    () => visibleDrivers.filter((d) => d.balance <= -5000 && d.work_status !== "fired").sort((a, b) => a.balance - b.balance),
    [visibleDrivers],
  );
  const debtSum = debtors.reduce((s, d) => s + Number(d.balance), 0);
  const overdue = visibleDrivers.filter((d) => d.promise_date && d.promise_date < today() && d.balance < 0);

  return (
    <div className="page">
      <div className="kpis">
        <Kpi label="На линии сейчас" value={totals.online} sub={`работают ${totals.working} из ${totals.drivers}`} tone="ok" />
        <Kpi label="Сумма в плюсе" value={money(totals.plus)} sub="к выплате водителям" />
        <Kpi label="Сумма в минусе" value={money(totals.minus)} sub={`${totals.minusCount} водителей`} tone="bad" />
        <Kpi label="Должники от 5 000 ₽" value={debtors.length} sub={money(debtSum)} tone="bad" onClick={() => go("debtors")} />
        {fin && <Kpi label="Пополнения за 7 дней" value={money(fin.topup)} tone="ok" onClick={() => go("finance")} />}
        {fin && <Kpi label="Выводы за 7 дней" value={money(Math.abs(fin.withdraw))} onClick={() => go("finance")} />}
        {fin && <Kpi label="Доход парка за 7 дней" value={money(Math.abs(fin.partner_fees) + Math.abs(fin.partner_other))}
                     sub="комиссия + списания" tone="info" onClick={() => go("finance")} />}
        <Kpi label="Просрочены обещания" value={overdue.length} tone={overdue.length ? "warn" : undefined} onClick={() => go("debtors")} />
      </div>

      <div className="grid-2">
        <Card title="Общий минус по дням">
          {history.length < 2 ? (
            <Empty>История копится с момента подключения: график появится через пару дней.</Empty>
          ) : (
            <ResponsiveContainer width="100%" height={240}>
              <AreaChart data={history} margin={{ left: 8, right: 8, top: 8 }}>
                <CartesianGrid strokeDasharray="3 3" className="grid-line" />
                <XAxis dataKey="day" tickFormatter={fmtDay} fontSize={12} />
                <YAxis tickFormatter={shortMoney} fontSize={12} width={60} />
                <Tooltip formatter={(v) => money(v)} labelFormatter={fmtDay} />
                <Area dataKey="minus" name="Минус" stroke="var(--bad)" fill="var(--bad-soft)" />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </Card>

        <Card title="Самые крупные долги" actions={<button className="link" onClick={() => go("debtors")}>Все должники →</button>}>
          {debtors.length === 0 ? <Empty>Должников нет 🎉</Empty> : (
            <ul className="mini-list">
              {debtors.slice(0, 8).map((d) => (
                <li key={d.id} onClick={() => setOpenDriver(d.id)}>
                  <div>
                    <b>{fullName(d)}</b>
                    <div className="muted small">
                      {d.park_name} · {ONLINE.has(d.current_status) ? "на линии" : `офлайн ${ago(d.status_updated_at)}`}
                      {d.work_status !== "working" && <> · {WORK_STATUS[d.work_status]?.label}</>}
                    </div>
                  </div>
                  <Money value={d.balance} />
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card title="Парки">
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Парк</th><th className="num">Водителей</th><th className="num">Работают</th>
                <th className="num">На линии</th><th className="num">В плюсе</th><th className="num">В минусе</th>
                <th>Синхронизация</th>
              </tr>
            </thead>
            <tbody>
              {shownParks.map((p) => (
                <tr key={p.id}>
                  <td><b>{p.name}</b></td>
                  <td className="num">{p.drivers_total}</td>
                  <td className="num">{p.drivers_working}</td>
                  <td className="num">{p.online}</td>
                  <td className="num"><Money value={p.plus_sum} /></td>
                  <td className="num"><Money value={p.minus_sum} /></td>
                  <td>
                    {p.last_sync_error ? <Badge tone="bad" title={p.last_sync_error}>Ошибка</Badge>
                      : <span className="muted small">{p.last_sync_at ? `${ago(p.last_sync_at)} назад` : "ещё не было"}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

export function today() {
  return new Date().toLocaleDateString("en-CA");
}
