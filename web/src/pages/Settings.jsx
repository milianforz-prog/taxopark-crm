import { useEffect, useState } from "react";
import { Badge, Card, Empty } from "../components/ui";
import { ago, fmtDate } from "../lib/format";
import { useData } from "../lib/store";
import { supabase } from "../lib/supabase";

export default function Settings() {
  const { me } = useData();
  return (
    <div className="page">
      <Profile />
      {me.role === "owner" ? (
        <>
          <Parks />
          <Staff />
        </>
      ) : (
        <Empty>Управление парками и сотрудниками доступно владельцу.</Empty>
      )}
    </div>
  );
}

function Profile() {
  const { me } = useData();
  return (
    <Card title="Мой профиль">
      <div className="dc-facts">
        <div className="fact"><div className="muted small">Email</div><div>{me.email}</div></div>
        <div className="fact"><div className="muted small">Роль</div><div>{me.role === "owner" ? "Владелец" : "Менеджер"}</div></div>
      </div>
      <button className="btn" onClick={() => supabase.auth.signOut()}>Выйти</button>
    </Card>
  );
}

function Parks() {
  const { parks, reload, syncNow, syncing } = useData();
  const [form, setForm] = useState({ name: "", parkId: "", clientId: "", apiKey: "" });
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  const add = async (e) => {
    e.preventDefault();
    setBusy(true);
    setMsg("");
    const { error } = await supabase.rpc("add_park", {
      p_name: form.name.trim() || "Новый парк",
      p_fleet_park_id: form.parkId.trim(),
      p_client_id: form.clientId.trim(),
      p_api_key: form.apiKey.trim(),
    });
    if (error) setMsg("❌ " + error.message);
    else {
      setForm({ name: "", parkId: "", clientId: "", apiKey: "" });
      setMsg("✅ Парк сохранён. Запускаю синхронизацию…");
      await reload();
      await syncNow();
      setMsg("✅ Парк добавлен и синхронизирован.");
    }
    setBusy(false);
  };

  const toggle = async (p) => {
    await supabase.rpc("set_park_active", { p_park: p.id, p_active: !p.active });
    reload();
  };

  return (
    <Card title="Парки" actions={<button className="btn" disabled={syncing} onClick={syncNow}>{syncing ? "Синхронизация…" : "⟳ Синхронизировать сейчас"}</button>}>
      <div className="table-wrap">
        <table className="table compact">
          <thead><tr><th>Парк</th><th className="num">Водителей</th><th>Последняя синхронизация</th><th>Транзакции до</th><th /></tr></thead>
          <tbody>
            {parks.map((p) => (
              <tr key={p.id}>
                <td><b>{p.name}</b> {!p.active && <Badge>выключен</Badge>}</td>
                <td className="num">{p.drivers_total}</td>
                <td>
                  {p.last_sync_error ? <span className="tone-bad small" title={p.last_sync_error}>Ошибка: {p.last_sync_error.slice(0, 80)}</span>
                    : p.last_sync_at ? `${ago(p.last_sync_at)} назад` : "ещё не было"}
                </td>
                <td className="small">{fmtDate(p.tx_synced_until)}</td>
                <td><button className="link small" onClick={() => toggle(p)}>{p.active ? "выключить" : "включить"}</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h3 className="h3">Добавить парк</h3>
      <p className="muted small">
        Данные берутся в кабинете Яндекс Про → Настройки → API. Ключу нужны права на чтение водителей и транзакций.
        Ключ сохраняется в закрытой части базы: из браузера его прочитать нельзя.
      </p>
      <form className="form-grid" onSubmit={add}>
        <input className="input" placeholder="Название (необязательно)" value={form.name} onChange={set("name")} />
        <input className="input" placeholder="ID парка" required value={form.parkId} onChange={set("parkId")} />
        <input className="input" placeholder="Client ID (taxi/park/…) — можно пусто" value={form.clientId} onChange={set("clientId")} />
        <input className="input" placeholder="API-ключ" required type="password" autoComplete="off" value={form.apiKey} onChange={set("apiKey")} />
        <button className="btn primary" disabled={busy}>Добавить парк</button>
      </form>
      {msg && <div className="small" style={{ marginTop: 8 }}>{msg}</div>}
    </Card>
  );
}

function Staff() {
  const { me } = useData();
  const [staff, setStaff] = useState([]);
  const load = () => supabase.from("staff").select("*").order("created_at").then(({ data }) => setStaff(data || []));
  useEffect(() => { load(); }, []);

  const update = async (s, patch) => {
    await supabase.from("staff").update(patch).eq("user_id", s.user_id);
    load();
  };
  const remove = async (s) => {
    if (!confirm(`Удалить доступ для ${s.email}?`)) return;
    await supabase.from("staff").delete().eq("user_id", s.user_id);
    load();
  };

  return (
    <Card title="Сотрудники">
      <p className="muted small">
        Сотрудник регистрируется на странице входа сам («Регистрация»), затем вы одобряете его здесь.
      </p>
      <div className="table-wrap">
        <table className="table compact">
          <thead><tr><th>Сотрудник</th><th>Роль</th><th>Доступ</th><th /></tr></thead>
          <tbody>
            {staff.map((s) => (
              <tr key={s.user_id}>
                <td>{s.full_name || "—"}<div className="muted small">{s.email}</div></td>
                <td>
                  {s.user_id === me.user_id ? "Владелец" : (
                    <select className="input" value={s.role} onChange={(e) => update(s, { role: e.target.value })}>
                      <option value="manager">Менеджер</option>
                      <option value="owner">Владелец</option>
                    </select>
                  )}
                </td>
                <td>
                  {s.approved ? <Badge tone="ok">открыт</Badge> : <Badge tone="warn">ждёт одобрения</Badge>}
                </td>
                <td className="nowrap">
                  {s.user_id !== me.user_id && (
                    <>
                      <button className="link small" onClick={() => update(s, { approved: !s.approved })}>
                        {s.approved ? "закрыть доступ" : "✅ одобрить"}
                      </button>{" "}
                      <button className="link small tone-bad" onClick={() => remove(s)}>удалить</button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
