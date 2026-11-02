import { useEffect, useState } from "react";
import DriverCard from "./components/DriverCard";
import { ICONS } from "./components/icons";
import { Checker, Spinner } from "./components/ui";
import { ago } from "./lib/format";
import { DataProvider, useData } from "./lib/store";
import { supabase } from "./lib/supabase";
import Debtors from "./pages/Debtors";
import Drivers from "./pages/Drivers";
import Finance from "./pages/Finance";
import History from "./pages/History";
import Login, { Brand, SetPassword } from "./pages/Login";
import Settings from "./pages/Settings";
import Summary from "./pages/Summary";

const PAGES = [
  { id: "summary", label: "Сводка", Comp: Summary },
  { id: "debtors", label: "Должники", Comp: Debtors },
  { id: "drivers", label: "Водители", Comp: Drivers },
  { id: "finance", label: "Финансы", Comp: Finance },
  { id: "history", label: "История", Comp: History },
  { id: "settings", label: "Настройки", Comp: Settings },
];

function useHashPage() {
  const read = () => window.location.hash.replace(/^#\/?/, "").split("/")[0] || "summary";
  const [page, setPage] = useState(read);
  useEffect(() => {
    const on = () => setPage(read());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return [page, (p) => { window.location.hash = "/" + p; }];
}

export default function App() {
  const [session, setSession] = useState(undefined);
  const [me, setMe] = useState(undefined);
  const [recovery, setRecovery] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = supabase.auth.onAuthStateChange((event, s) => {
      if (event === "PASSWORD_RECOVERY") setRecovery(true);
      setSession(s);
    });
    return () => data.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session) {
      setMe(session === null ? null : undefined);
      return;
    }
    supabase.from("staff").select("*").eq("user_id", session.user.id).maybeSingle()
      .then(({ data }) => setMe(data || { email: session.user.email, approved: false }));
  }, [session]);

  if (session === undefined) return <div className="center"><Spinner /></div>;
  if (recovery) return <SetPassword onDone={() => setRecovery(false)} />;
  if (!session) return <Login />;
  if (me === undefined) return <div className="center"><Spinner /></div>;
  if (!me?.approved) {
    return (
      <div className="login">
        <Brand />
        <div className="login-card">
          <h2 className="login-title">Доступ ожидает одобрения</h2>
          <p>Вы вошли как <b>{session.user.email}</b>. Владелец парка должен открыть вам доступ в разделе «Настройки → Сотрудники».</p>
          <button className="btn" onClick={() => window.location.reload()}>Проверить снова</button>
          <button className="link" onClick={() => supabase.auth.signOut()}>Выйти</button>
        </div>
      </div>
    );
  }
  return (
    <DataProvider me={me}>
      <Shell />
    </DataProvider>
  );
}

function Shell() {
  const [page, go] = useHashPage();
  const { parks, parkFilter, selectPark, loading, error, loadedAt, syncNow, syncing } = useData();
  const current = PAGES.find((p) => p.id === page) || PAGES[0];
  const lastSync = parks.map((p) => p.last_sync_at).filter(Boolean).sort().at(0);

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="side-brand">
          <Checker cols={6} />
          <span>Таксопарк</span>
        </div>
        <nav>
          {PAGES.map((p) => (
            <a key={p.id} href={`#/${p.id}`} className={p.id === current.id ? "active" : ""}>
              <span className="nav-icon" aria-hidden="true">{ICONS[p.id]}</span><span className="nav-label">{p.label}</span>
            </a>
          ))}
        </nav>
      </aside>
      <main className="main">
        <header className="topbar">
          <h1><Checker cols={3} className="h1-checker" />{current.label}</h1>
          <div className="topbar-right">
            <select className="input park-select" value={parkFilter} onChange={(e) => selectPark(e.target.value)}>
              <option value="all">Все парки ({parks.length})</option>
              {parks.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <button className="btn" onClick={syncNow} disabled={syncing}
                    title={lastSync ? `Данные из Яндекса: ${ago(lastSync)} назад` : ""}>
              <span className={syncing ? "spin-icon on" : "spin-icon"}>⟳</span>
              <span className="sync-label">{syncing ? "Обновляю…" : lastSync ? `${ago(lastSync)} назад` : "Обновить"}</span>
            </button>
          </div>
        </header>
        {error && <div className="error banner">{error}</div>}
        {loading && !loadedAt ? <Spinner /> : <current.Comp go={go} />}
      </main>
      <DriverCard />
    </div>
  );
}
