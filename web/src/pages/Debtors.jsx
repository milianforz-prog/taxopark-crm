import { useMemo, useState } from "react";
import { Badge, Chips, Delta, Empty, Money, Pager, Plate, SortHeader, sortRows } from "../components/ui";
import { ago, CRM_STATUS, csvDownload, fmtDate, fmtDay, fullName, money, ONLINE, WORK_STATUS } from "../lib/format";
import { localGet, localSet, useData } from "../lib/store";
import { today } from "./Summary";

const THRESHOLDS = [3000, 5000, 10000, 20000];
const PAGE = 50;

export default function Debtors() {
  const { visibleDrivers, setOpenDriver } = useData();
  const [threshold, setThreshold] = useState(() => Number(localGet("threshold")) || 5000);
  const [work, setWork] = useState("active");
  const [crm, setCrm] = useState("all");
  const [q, setQ] = useState("");
  const [sort, setSort] = useState({ field: "balance", dir: "asc" });
  const [page, setPage] = useState(0);

  const changeThreshold = (v) => {
    setThreshold(v);
    localSet("threshold", v);
    setPage(0);
  };

  const rows = useMemo(() => {
    const query = q.trim().toLowerCase();
    const filtered = visibleDrivers.filter((d) => {
      if (d.balance > -threshold) return false;
      if (work === "active" && d.work_status === "fired") return false;
      if (work !== "active" && work !== "all" && d.work_status !== work) return false;
      if (crm === "overdue") {
        if (!(d.promise_date && d.promise_date < today())) return false;
      } else if (crm !== "all" && (d.crm_status || "new") !== crm) return false;
      if (query && !`${fullName(d, true)} ${d.phone || ""} ${d.car_number || ""}`.toLowerCase().includes(query)) return false;
      return true;
    });
    return sortRows(filtered, sort, {
      name: (d) => fullName(d),
      week: (d) => (d.balance_week_ago == null ? null : d.balance - d.balance_week_ago),
      offline: (d) => (ONLINE.has(d.current_status) ? -1 : new Date(d.status_updated_at || 0).getTime() * -1),
      crm: (d) => CRM_STATUS[d.crm_status || "new"].label,
    });
  }, [visibleDrivers, threshold, work, crm, q, sort]);

  const total = rows.reduce((s, d) => s + Number(d.balance), 0);
  const pages = Math.ceil(rows.length / PAGE);
  const shown = rows.slice(page * PAGE, page * PAGE + PAGE);

  const exportCsv = () =>
    csvDownload(`dolzhniki_${today()}.csv`,
      ["Водитель", "Телефон", "Парк", "Баланс", "Статус", "На линии", "CRM", "Обещание", "Сумма обещания", "Комментарий"],
      rows.map((d) => [fullName(d, true), d.phone, d.park_name, d.balance, WORK_STATUS[d.work_status]?.label,
        ONLINE.has(d.current_status) ? "да" : `офлайн ${ago(d.status_updated_at)}`,
        CRM_STATUS[d.crm_status || "new"].label, d.promise_date, d.promise_amount, d.last_note]));

  return (
    <div className="page">
      <div className="toolbar">
        <div className="toolbar-group">
          <span className="muted small">Долг от</span>
          <Chips value={threshold} onChange={changeThreshold}
                 options={THRESHOLDS.map((t) => ({ value: t, label: money(-t) }))} />
          <input className="input narrow" type="number" min="0" step="500" value={threshold}
                 onChange={(e) => changeThreshold(Math.abs(Number(e.target.value)) || 0)} />
        </div>
        <div className="toolbar-group">
          <select className="input" value={work} onChange={(e) => { setWork(e.target.value); setPage(0); }}>
            <option value="active">Без уволенных</option>
            <option value="working">Работают</option>
            <option value="not_working">Не работают</option>
            <option value="fired">Уволены</option>
            <option value="all">Все</option>
          </select>
          <select className="input" value={crm} onChange={(e) => { setCrm(e.target.value); setPage(0); }}>
            <option value="all">Любой статус CRM</option>
            <option value="overdue">⚠️ Просрочено обещание</option>
            {Object.entries(CRM_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
          <input className="input" placeholder="Поиск: ФИО, телефон, госномер" value={q}
                 onChange={(e) => { setQ(e.target.value); setPage(0); }} />
          <button className="btn" onClick={exportCsv}>⬇ Excel</button>
        </div>
      </div>

      <div className="summary-line">
        <b>{rows.length}</b> должников · итого <Money value={total} />
      </div>

      {rows.length === 0 ? <Empty>Должников по этим условиям нет</Empty> : (
        <div className="table-wrap card">
          <table className="table hover responsive">
            <thead>
              <tr>
                <SortHeader label="Водитель" field="name" sort={sort} setSort={setSort} />
                <th>Парк</th>
                <SortHeader label="Баланс" field="balance" sort={sort} setSort={setSort} className="num" />
                <SortHeader label="За неделю" field="week" sort={sort} setSort={setSort} className="num" />
                <SortHeader label="На линии" field="offline" sort={sort} setSort={setSort} />
                <SortHeader label="Работа с долгом" field="crm" sort={sort} setSort={setSort} />
                <th>Последний комментарий</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((d) => {
                const st = CRM_STATUS[d.crm_status || "new"];
                const overdue = d.promise_date && d.promise_date < today();
                return (
                  <tr key={d.id} onClick={() => setOpenDriver(d.id)}>
                    <td className="c-main">
                      <b>{fullName(d)}</b>
                      <div className="muted small row-meta">
                        <span>{d.phone || "нет телефона"}</span>
                        <Plate number={d.car_number} />
                        {d.work_status !== "working" && <span className="tone-warn">{WORK_STATUS[d.work_status]?.label}</span>}
                      </div>
                    </td>
                    <td className="small c-sub">{d.park_name}</td>
                    <td className="num c-bal"><Money value={d.balance} /></td>
                    <td className="num small c-meta" data-label="За неделю">
                      <Delta value={d.balance_week_ago == null ? null : d.balance - d.balance_week_ago} />
                    </td>
                    <td className="small c-meta" data-label="На линии">
                      {ONLINE.has(d.current_status) ? <Badge tone="ok">на линии</Badge> : <span className="muted">{ago(d.status_updated_at) || "—"}</span>}
                    </td>
                    <td className="c-meta">
                      <Badge tone={st.tone}>{st.label}</Badge>
                      {d.promise_date && (
                        <div className={`small ${overdue ? "tone-bad" : "muted"}`}>
                          {overdue ? "⚠️ просрочено " : "до "}{fmtDay(d.promise_date)}
                          {d.promise_amount ? ` · ${money(d.promise_amount)}` : ""}
                        </div>
                      )}
                    </td>
                    <td className="small note-cell c-note">
                      {d.last_note ? <>{d.last_note}<div className="muted">{fmtDate(d.last_note_at)}</div></> : <span className="muted">—</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <Pager page={page} pages={pages} setPage={setPage} />
        </div>
      )}
    </div>
  );
}
