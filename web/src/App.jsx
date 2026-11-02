import { useEffect, useState } from "react";
import DriverCard from "./components/DriverCard";
import { Spinner } from "./components/ui";
import { ago } from "./lib/format";
import { DataProvider, useData } from "./lib/store";
import { supabase } from "./lib/supabase";
import Debtors from "./pages/Debtors";
import Drivers from "./pages/Drivers";
import Finance from "./pages/Finance";
import History from "./pages/History";
import Login, { SetPassword } from "./pages/Login";
import Settings from "./pages/Settings";
import Summary from "./pages/Summary";

const PAGES = [
  { id: "summary", label: "Сводка", icon: "📊", Comp: Summary },
  { id: "debtors", label: "Должники", icon: "💸", Comp: Debtors },
  { id: "drivers", label: "Водители", icon: "👥", Comp: Drivers },
  { id: "finance", label: "Финансы", icon: "💰", Comp: Finance },
  { id: "history", label: "История", icon: "📈", Comp: History },
  { id: "settings", label: "Настройки", icon: "⚙️", Comp: Settings },
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
        <div className="login-card">
          <div className="logo">⏳ Доступ ожидает одобрения</div>
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
        <div className="logo">🚕 Таксопарк</div>
        <nav>
          {PAGES.map((p) => (
            <a key={p.id} href={`#/${p.id}`} className={p.id === current.id ? "active" : ""}>
              <span className="nav-icon">{p.icon}</span><span className="nav-label">{p.label}</span>
            </a>
          ))}
        </nav>
      </aside>
      <main className="main">
        <header className="topbar">
          <h1>{current.label}</h1>
          <div className="topbar-right">
            <select className="input" value={parkFilter} onChange={(e) => selectPark(e.target.value)}>
              <option value="all">Все парки ({parks.length})</option>
              {parks.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <button className="btn" onClick={syncNow} disabled={syncing}
                    title={lastSync ? `Данные из Яндекса: ${ago(lastSync)} назад` : ""}>
              {syncing ? "⟳ Обновляю…" : `⟳ ${lastSync ? ago(lastSync) + " назад" : "Обновить"}`}
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
