import { useMemo, useState } from "react";
import { Badge, Empty, Money, Pager, SortHeader, sortRows } from "../components/ui";
import { ago, csvDownload, CURRENT_STATUS, fmtDate, fullName, ONLINE, WORK_STATUS } from "../lib/format";
import { useData } from "../lib/store";
import { today } from "./Summary";

const PAGE = 50;

export default function Drivers() {
  const { visibleDrivers, setOpenDriver } = useData();
  const [work, setWork] = useState("active");
  const [online, setOnline] = useState("all");
  const [bal, setBal] = useState("all");
  const [q, setQ] = useState("");
  const [sort, setSort] = useState({ field: "name", dir: "asc" });
  const [page, setPage] = useState(0);
  const reset = (fn) => (e) => { fn(e.target.value); setPage(0); };

  const rows = useMemo(() => {
    const query = q.trim().toLowerCase();
    const filtered = visibleDrivers.filter((d) => {
      if (work === "active" && d.work_status === "fired") return false;
      if (work !== "active" && work !== "all" && d.work_status !== work) return false;
      if (online === "online" && !ONLINE.has(d.current_status)) return false;
      if (online === "offline" && ONLINE.has(d.current_status)) return false;
      if (online === "lost7" && (ONLINE.has(d.current_status) || daysOff(d) < 7)) return false;
      if (bal === "plus" && d.balance <= 0) return false;
      if (bal === "minus" && d.balance >= 0) return false;
      if (query && !`${fullName(d, true)} ${d.phone || ""} ${d.car_number || ""}`.toLowerCase().includes(query)) return false;
      return true;
    });
    return sortRows(filtered, sort, {
      name: (d) => fullName(d),
      last: (d) => (ONLINE.has(d.current_status) ? Date.now() : new Date(d.status_updated_at || 0).getTime()),
    });
  }, [visibleDrivers, work, online, bal, q, sort]);

  const pages = Math.ceil(rows.length / PAGE);
  const shown = rows.slice(page * PAGE, page * PAGE + PAGE);

  const exportCsv = () =>
    csvDownload(`voditeli_${today()}.csv`,
      ["Водитель", "Телефон", "Парк", "Баланс", "Статус", "Сейчас", "Последний раз на линии", "Авто", "Госномер", "Принят"],
      rows.map((d) => [fullName(d, true), d.phone, d.park_name, d.balance, WORK_STATUS[d.work_status]?.label,
        CURRENT_STATUS[d.current_status]?.label, fmtDate(d.status_updated_at), d.car, d.car_number, d.hire_date]));

  return (
    <div className="page">
      <div className="toolbar">
        <div className="toolbar-group">
          <input className="input grow" placeholder="Поиск: ФИО, телефон, госномер" value={q} onChange={reset(setQ)} />
          <select className="input" value={work} onChange={reset(setWork)}>
            <option value="active">Без уволенных</option>
            <option value="working">Работают</option>
            <option value="not_working">Не работают</option>
            <option value="fired">Уволены</option>
            <option value="all">Все</option>
          </select>
          <select className="input" value={online} onChange={reset(setOnline)}>
            <option value="all">Онлайн и офлайн</option>
            <option value="online">Сейчас на линии</option>
            <option value="offline">Офлайн</option>
            <option value="lost7">Не выходили 7+ дней</option>
          </select>
          <select className="input" value={bal} onChange={reset(setBal)}>
            <option value="all">Любой баланс</option>
            <option value="plus">В плюсе</option>
            <option value="minus">В минусе</option>
          </select>
          <button className="btn" onClick={exportCsv}>⬇ Excel</button>
        </div>
      </div>
      <div className="summary-line"><b>{rows.length}</b> водителей</div>

      {rows.length === 0 ? <Empty>Никого не нашлось</Empty> : (
        <div className="table-wrap card">
          <table className="table hover">
            <thead>
              <tr>
                <SortHeader label="Водитель" field="name" sort={sort} setSort={setSort} />
                <th>Парк</th>
                <SortHeader label="Баланс" field="balance" sort={sort} setSort={setSort} className="num" />
                <th>Статус</th>
                <SortHeader label="Последний раз на линии" field="last" sort={sort} setSort={setSort} />
                <th>Авто</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((d) => {
                const cs = CURRENT_STATUS[d.current_status] || CURRENT_STATUS.offline;
                const ws = WORK_STATUS[d.work_status];
                return (
                  <tr key={d.id} onClick={() => setOpenDriver(d.id)}>
                    <td><b>{fullName(d)}</b><div className="muted small">{d.phone || "нет телефона"}</div></td>
                    <td className="small">{d.park_name}</td>
                    <td className="num"><Money value={d.balance} /></td>
                    <td>
                      <Badge tone={cs.tone}>{cs.label}</Badge>{" "}
                      {ws && d.work_status !== "working" && <Badge tone={ws.tone}>{ws.label}</Badge>}
                    </td>
                    <td className="small">{ONLINE.has(d.current_status) ? "сейчас" : d.status_updated_at ? `${ago(d.status_updated_at)} назад` : "—"}</td>
                    <td className="small">{d.car || "—"}<div className="muted">{d.car_number}</div></td>
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

function daysOff(d) {
  return d.status_updated_at ? (Date.now() - new Date(d.status_updated_at).getTime()) / 86400000 : 999;
}
