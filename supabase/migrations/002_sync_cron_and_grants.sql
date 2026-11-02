-- Расписание синхронизации и уточнения после первого запуска

-- парки, которые дольше всех не синхронизировались, идут первыми
create or replace function public.sync_get_parks()
returns table (id uuid, name text, fleet_park_id text, client_id text, api_key text, tx_synced_until timestamptz)
language sql security definer set search_path = '' as $$
  select p.id, p.name, p.fleet_park_id, k.client_id, k.api_key, p.tx_synced_until
  from public.parks p join private.park_keys k on k.park_id = p.id
  where p.active
  order by p.last_sync_at nulls first;
$$;
revoke execute on function public.sync_get_parks() from public, anon, authenticated;
grant execute on function public.sync_get_parks() to service_role;

create or replace function private.run_sync() returns bigint
language sql security definer set search_path = '' as $$
  select net.http_post(
    url := 'https://ovgiuxulyrxiljfqpaml.supabase.co/functions/v1/sync',
    headers := jsonb_build_object('Content-Type', 'application/json',
                                  'x-sync-secret', (select value from private.settings where key = 'sync_secret')),
    body := '{}'::jsonb,
    timeout_milliseconds := 150000
  );
$$;

select cron.schedule('taxopark-sync', '*/10 * * * *', 'select private.run_sync()');

-- уволенные не считаются должниками в истории
create or replace view public.daily_balance with (security_invoker = true) as
select
  s.day, s.park_id,
  coalesce(sum(s.balance) filter (where s.balance > 0), 0) as plus_sum,
  coalesce(sum(s.balance) filter (where s.balance < 0), 0) as minus_sum,
  count(*) filter (where s.balance < 0) as minus_count,
  count(*) filter (where s.balance <= -5000 and coalesce(d.work_status, '') <> 'fired') as debtors_5000
from public.balance_snapshots s
left join public.drivers d on d.id = s.driver_id
group by s.day, s.park_id;

-- служебные функции — только для вошедших
revoke execute on function public.is_staff() from public, anon;
revoke execute on function public.is_owner() from public, anon;
grant execute on function public.is_staff() to authenticated;
grant execute on function public.is_owner() to authenticated;
revoke execute on function public.set_note_author() from public, anon, authenticated;
revoke execute on function public.touch_crm() from public, anon, authenticated;
revoke execute on function public.finance_by_day(timestamptz, timestamptz, uuid, text) from public, anon;
revoke execute on function public.debt_changes(date, numeric) from public, anon;
grant execute on function public.finance_by_day(timestamptz, timestamptz, uuid, text) to authenticated;
grant execute on function public.debt_changes(date, numeric) to authenticated;
