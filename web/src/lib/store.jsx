import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { fetchAll, runSync, supabase } from "./supabase";

const DataContext = createContext(null);
const REFRESH_MS = 2 * 60 * 1000;

export function DataProvider({ me, children }) {
  const [parks, setParks] = useState([]);
  const [drivers, setDrivers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [loadedAt, setLoadedAt] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [openDriver, setOpenDriver] = useState(null);
  const [parkFilter, setParkFilter] = useState(() => localGet("park") || "all");

  const reload = useCallback(async () => {
    try {
      const [{ data: p, error: pe }, d] = await Promise.all([
        supabase.from("park_summary").select("*").order("name"),
        fetchAll(() => supabase.from("driver_list").select("*").order("id")),
      ]);
      if (pe) throw pe;
      setParks(p);
      setDrivers(d);
      setLoadedAt(new Date());
      setError("");
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    reload();
    const t = setInterval(reload, REFRESH_MS);
    return () => clearInterval(t);
  }, [reload]);

  const syncNow = useCallback(async () => {
    setSyncing(true);
    try {
      await runSync();
      await reload();
    } catch (e) {
      setError("Синхронизация: " + (e.message || e));
    } finally {
      setSyncing(false);
    }
  }, [reload]);

  const selectPark = (id) => {
    setParkFilter(id);
    localSet("park", id);
  };

  const parkById = useMemo(() => Object.fromEntries(parks.map((p) => [p.id, p])), [parks]);
  const driverById = useMemo(() => Object.fromEntries(drivers.map((d) => [d.id, d])), [drivers]);
  const visibleDrivers = useMemo(
    () => (parkFilter === "all" ? drivers : drivers.filter((d) => d.park_id === parkFilter)),
    [drivers, parkFilter],
  );

  const value = {
    me, parks, parkById, drivers, driverById, visibleDrivers, loading, error, loadedAt,
    reload, syncNow, syncing, openDriver, setOpenDriver, parkFilter, selectPark,
  };
  return <DataContext.Provider value={value}>{children}</DataContext.Provider>;
}

export const useData = () => useContext(DataContext);

function localGet(k) {
  try { return localStorage.getItem("crm." + k); } catch { return null; }
}
function localSet(k, v) {
  try { localStorage.setItem("crm." + k, v); } catch { /* приватный режим */ }
}
export { localGet, localSet };
