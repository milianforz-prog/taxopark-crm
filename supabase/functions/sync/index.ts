// Синхронизация CRM с Fleet API Яндекс Про: водители, балансы (снимок за день) и транзакции.
// Вызывается pg_cron каждые 10 минут (заголовок x-sync-secret) или кнопкой «Обновить» в CRM (JWT сотрудника).
import { createClient, SupabaseClient } from "jsr:@supabase/supabase-js@2";

const FLEET = "https://fleet-api.taxi.yandex.net";
const TIME_BUDGET_MS = 110_000; // бесплатный тариф даёт функции ~150 с
const TX_BACKFILL_DAYS = 30; // при первом запуске подтягиваем транзакции за 30 дней
const TX_WINDOW_MS = 24 * 3600_000; // транзакции забираем окнами по суткам
const TX_OVERLAP_MS = 15 * 60_000; // перекрытие окон, чтобы не потерять поздние записи

type Park = {
  id: string;
  name: string;
  fleet_park_id: string;
  client_id: string;
  api_key: string;
  tx_synced_until: string | null;
};

let started = Date.now(); // сбрасывается в начале каждого запроса
const timeLeft = () => TIME_BUDGET_MS - (Date.now() - started);

async function fleet(park: Park, path: string, body: unknown) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(FLEET + path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Client-ID": park.client_id,
        "X-API-Key": park.api_key,
        "Accept-Language": "ru",
      },
      body: JSON.stringify(body),
    });
    if (res.status === 429 && attempt < 3) {
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      continue;
    }
    const text = await res.text();
    if (!res.ok) throw new Error(`Fleet ${path} HTTP ${res.status}: ${text.slice(0, 300)}`);
    return JSON.parse(text);
  }
}

function moscowDate(d = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Moscow" }).format(d);
}

async function upsertChunks(sb: SupabaseClient, table: string, rows: unknown[], onConflict: string) {
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await sb.from(table).upsert(rows.slice(i, i + 500), { onConflict });
    if (error) throw new Error(`${table}: ${error.message}`);
  }
}

async function syncDrivers(sb: SupabaseClient, park: Park) {
  const rows: Record<string, unknown>[] = [];
  let offset = 0;
  let parkName = "";
  while (true) {
    const resp = await fleet(park, "/v1/parks/driver-profiles/list", {
      query: { park: { id: park.fleet_park_id } },
      fields: {
        account: ["balance", "last_transaction_date"],
        driver_profile: ["id", "first_name", "last_name", "middle_name", "phones", "work_status", "hire_date"],
        current_status: ["status", "status_updated_at"],
        car: ["brand", "model", "number"],
        park: ["name"],
      },
      limit: 1000,
      offset,
    });
    parkName ||= resp.parks?.[0]?.name ?? "";
    const page = resp.driver_profiles ?? [];
    for (const item of page) {
      const p = item.driver_profile ?? {};
      const acc = item.accounts?.[0] ?? {};
      const st = item.current_status ?? {};
      const car = item.car ?? {};
      rows.push({
        id: p.id,
        park_id: park.id,
        last_name: p.last_name ?? null,
        first_name: p.first_name ?? null,
        middle_name: p.middle_name ?? null,
        phone: p.phones?.[0] ?? null,
        work_status: p.work_status ?? null,
        current_status: st.status ?? null,
        status_updated_at: st.status_updated_at ?? null,
        balance: Number(acc.balance ?? 0),
        last_transaction_at: acc.last_transaction_date ?? null,
        hire_date: p.hire_date ? String(p.hire_date).slice(0, 10) : null,
        car: [car.brand, car.model].filter(Boolean).join(" ") || null,
        car_number: car.number ?? null,
        updated_at: new Date().toISOString(),
      });
    }
    offset += page.length;
    if (!page.length || offset >= (resp.total ?? 0)) break;
  }
  await upsertChunks(sb, "drivers", rows, "id");
  const day = moscowDate();
  await upsertChunks(
    sb,
    "balance_snapshots",
    rows.map((r) => ({ day, driver_id: r.id, park_id: park.id, balance: r.balance })),
    "day,driver_id",
  );
  return { count: rows.length, parkName };
}

async function syncTransactions(sb: SupabaseClient, park: Park) {
  const now = Date.now();
  let from = park.tx_synced_until
    ? new Date(park.tx_synced_until).getTime() - TX_OVERLAP_MS
    : now - TX_BACKFILL_DAYS * 24 * 3600_000;
  let total = 0;
  let syncedUntil = park.tx_synced_until;
  while (from < now && timeLeft() > 15_000) {
    const to = Math.min(from + TX_WINDOW_MS, now);
    const rows: Record<string, unknown>[] = [];
    let cursor = "";
    do {
      const resp = await fleet(park, "/v2/parks/transactions/list", {
        query: {
          park: {
            id: park.fleet_park_id,
            transaction: { event_at: { from: new Date(from).toISOString(), to: new Date(to).toISOString() } },
          },
        },
        limit: 1000,
        ...(cursor ? { cursor } : {}),
      });
      for (const t of resp.transactions ?? []) {
        rows.push({
          id: String(t.id),
          park_id: park.id,
          driver_id: t.driver_profile_id ?? null,
          event_at: t.event_at,
          category_id: t.category_id ?? null,
          category_name: t.category_name ?? null,
          group_id: t.group_id ?? null,
          amount: Number(t.amount ?? 0),
          description: t.description ?? null,
          created_by: t.created_by?.identity ?? null,
          order_short_id: t.order?.short_id ?? null,
        });
      }
      cursor = (resp.transactions?.length ?? 0) > 0 ? resp.cursor ?? "" : "";
    } while (cursor && timeLeft() > 10_000);
    if (cursor) break; // не успели забрать окно целиком — продолжим в следующий запуск
    await upsertChunks(sb, "transactions", rows, "id");
    total += rows.length;
    syncedUntil = new Date(to).toISOString();
    await sb.from("parks").update({ tx_synced_until: syncedUntil }).eq("id", park.id);
    from = to;
  }
  return { count: total, syncedUntil };
}

async function isAuthorized(sb: SupabaseClient, req: Request) {
  const secret = req.headers.get("x-sync-secret");
  if (secret) {
    const { data } = await sb.rpc("sync_secret");
    return data && secret === data;
  }
  const token = req.headers.get("Authorization")?.replace("Bearer ", "");
  if (!token) return false;
  const { data: user } = await sb.auth.getUser(token);
  if (!user?.user) return false;
  const { data: staff } = await sb.from("staff").select("approved").eq("user_id", user.user.id).maybeSingle();
  return !!staff?.approved;
}

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-sync-secret",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  started = Date.now();
  const sb = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );
  if (!(await isAuthorized(sb, req))) {
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: cors });
  }

  const { data: parks, error } = await sb.rpc("sync_get_parks");
  if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: cors });

  const result: Record<string, unknown>[] = [];
  for (const park of (parks ?? []) as Park[]) {
    const report: Record<string, unknown> = { park: park.name };
    try {
      const d = await syncDrivers(sb, park);
      report.drivers = d.count;
      const tx = await syncTransactions(sb, park);
      report.transactions = tx.count;
      report.tx_synced_until = tx.syncedUntil;
      const update: Record<string, unknown> = { last_sync_at: new Date().toISOString(), last_sync_error: null };
      if (d.parkName && d.parkName !== park.name) update.name = d.parkName;
      await sb.from("parks").update(update).eq("id", park.id);
    } catch (e) {
      report.error = String(e);
      await sb.from("parks").update({ last_sync_error: String(e).slice(0, 500) }).eq("id", park.id);
    }
    result.push(report);
    if (timeLeft() < 15_000) break;
  }
  return new Response(JSON.stringify({ ok: true, result, ms: Date.now() - started }), {
    headers: { ...cors, "Content-Type": "application/json" },
  });
});
