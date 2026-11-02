import { createClient } from "@supabase/supabase-js";

// Публичные значения: доступ к данным защищён RLS в базе, ключи парков в браузер не попадают.
export const SUPABASE_URL = "https://ovgiuxulyrxiljfqpaml.supabase.co";
const SUPABASE_KEY = "sb_publishable_rjQ3ACN8pGjwnw3FkpXubw_W9x5uaYI";

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Supabase отдаёт максимум 1000 строк за запрос — забираем всё страницами.
export async function fetchAll(build, pageSize = 1000) {
  const rows = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await build().range(from, from + pageSize - 1);
    if (error) throw error;
    rows.push(...data);
    if (data.length < pageSize) return rows;
  }
}

export async function runSync() {
  const { data, error } = await supabase.functions.invoke("sync", { body: {} });
  if (error) throw error;
  return data;
}
