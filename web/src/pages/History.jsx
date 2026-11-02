import { useEffect, useMemo, useState } from "react";
import { Bar, CartesianGrid, ComposedChart, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Card, Empty, Money, Spinner } from "../components/ui";
import { fmtDay, fullName, money, shortMoney } from "../lib/format";
import { useData } from "../lib/store";
import { supabase } from "../lib/supabase";

export default function History() {
  const { parkFilter, driverById, setOpenDriver } = useData();
  const [days, setDays] = useState(null);
  const [day, setDay] = useState(() => new Date().toLocaleDateString("en-CA"));
  const [threshold, setThreshold] = useState(5000);
  const [changes, setChanges] = useState(null);

  useEffect(() => {
    const since = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
    let q = supabase.from("daily_balance").select("*").gte("day", since).order("day");
    if (parkFilter !== "all") q = q.eq("park_id", parkFilter);
    q.then(({ data }) => {
      const byDay = {};
      for (const r of data || []) {
        const d = (byDay[r.day] ||= { day: r.day, minus: 0, plus: 0, debtors: 0, minusCount: 0 });
        d.minus += Number(r.minus_sum);
        d.plus += Number(r.plus_sum);
        d.debtors += r.debtors_5000;
        d.minusCount += r.minus_count;
      }
      setDays(Object.values(byDay));
    });
  }, [parkFilter]);

  useEffect(() => {
    setChanges(null);
    supabase.rpc("debt_changes", { p_day: day, p_threshold: threshold }).then(({ data }) => {
      const rows = (data || []).filter((r) => parkFilter === "all" || r.park_id === parkFilter);
      setChanges(rows);
    });
  }, [day, threshold, parkFilter]);

  const table = useMemo(() => (days || []).slice().reverse().map((d, i, arr) => ({
    ...d, delta: arr[i + 1] ? d.minus - arr[i + 1].minus : null,
  })), [days]);

  const newDebtors = (changes || []).filter((c) => c.change === "new_debtor");
  const paidOff = (changes || []).filter((c) => c.change === "paid_off");

  return (
    <div className="page">
      <Card title="Долг по дням">
        {days === null ? <Spinner /> : days.length < 2 ? (
          <Empty>Снимки балансов сохраняются каждый день с момента подключения CRM. Через несколько дней здесь появится динамика.</Empty>
        ) : (
          <ResponsiveContainer width="100%" height={280}>
            <ComposedChart data={days} margin={{ left: 4, right: 8, top: 8 }}>
              <CartesianGrid strokeDasharray="3 3" className="grid-line" />
              <XAxis dataKey="day" tickFormatter={fmtDay} fontSize={12} />
              <YAxis yAxisId="m" tickFormatter={shortMoney} fontSize={12} width={60} />
              <YAxis yAxisId="c" orientation="right" fontSize={12} width={36} />
              <Tooltip formatter={(v, n) => (n === "Должников от 5 000" ? v : money(v))} labelFormatter={fmtDay} />
              <Legend />
              <Bar yAxisId="m" dataKey="minus" name="Сумма минуса" fill="var(--bad-soft)" stroke="var(--bad)" />
              <Line yAxisId="c" dataKey="debtors" name="Должников от 5 000" stroke="var(--accent)" strokeWidth={2} dot={false} />
            </ComposedChart>
          </ResponsiveContainer>
        )}
      </Card>

      <Card title="Кто стал должником и кто погасил" actions={
        <>
          <input className="input" type="date" value={day} onChange={(e) => setDay(e.target.value)} />
          <select className="input" value={threshold} onChange={(e) => setThreshold(Number(e.target.value))}>
            {[3000, 5000, 10000].map((t) => <option key={t} value={t}>порог {money(-t)}</option>)}
          </select>
        </>
      }>
        <p className="muted small">Сравнение балансов за {fmtDay(day)} с предыдущим днём.</p>
        {changes === null ? <Spinner /> : (
          <div className="grid-2">
            <ChangeList title={`🔴 Новые должники (${newDebtors.length})`} items={newDebtors} driverById={driverById} open={setOpenDriver} />
            <ChangeList title={`🟢 Погасили долг (${paidOff.length})`} items={paidOff} driverById={driverById} open={setOpenDriver} />
          </div>
        )}
      </Card>

      {table.length > 0 && (
        <Card title="Таблица по дням">
          <div className="table-wrap">
            <table className="table compact">
              <thead><tr><th>День</th><th className="num">Сумма минуса</th><th className="num">Изменение</th>
                <th className="num">В минусе</th><th className="num">Должников от 5 000</th><th className="num">Сумма плюса</th></tr></thead>
              <tbody>
                {table.map((d) => (
                  <tr key={d.day}>
                    <td>{fmtDay(d.day)}</td>
                    <td className="num"><Money value={d.minus} /></td>
                    <td className="num">{d.delta == null ? "—" : <span className={d.delta < 0 ? "tone-bad" : "tone-ok"}>{money(d.delta, { sign: true })}</span>}</td>
                    <td className="num">{d.minusCount}</td>
                    <td className="num">{d.debtors}</td>
                    <td className="num"><Money value={d.plus} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}

function ChangeList({ title, items, driverById, open }) {
  return (
    <div>
      <h3 className="h3">{title}</h3>
      {items.length === 0 ? <Empty>Никого</Empty> : (
        <ul className="mini-list">
          {items.map((c) => {
            const d = driverById[c.driver_id];
            return (
              <li key={c.driver_id} onClick={() => d && open(c.driver_id)}>
                <div>
                  <b>{d ? fullName(d) : c.driver_id}</b>
                  <div className="muted small">было {money(c.balance_before ?? 0)}</div>
                </div>
                <Money value={c.balance_after ?? 0} />
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
