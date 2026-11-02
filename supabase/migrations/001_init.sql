-- Таксопарк CRM: схема базы
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- ---------- закрытая схема: ключи и настройки (недоступна из браузера) ----------
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table private.settings (
  key text primary key,
  value text not null
);

-- ---------- сотрудники ----------
create table public.staff (
  user_id uuid primary key references auth.users on delete cascade,
  email text not null,
  full_name text,
  role text not null default 'manager' check (role in ('owner', 'manager')),
  approved boolean not null default false,
  created_at timestamptz not null default now()
);

create or replace function public.is_staff() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.staff where user_id = auth.uid() and approved);
$$;

create or replace function public.is_owner() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.staff where user_id = auth.uid() and approved and role = 'owner');
$$;

-- новый пользователь попадает в staff; владелец (email из private.settings) одобрен сразу
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  owner_email text := (select value from private.settings where key = 'owner_email');
  is_owner boolean := lower(new.email) = lower(coalesce(owner_email, ''));
begin
  insert into public.staff (user_id, email, full_name, role, approved)
  values (new.id, new.email, new.raw_user_meta_data ->> 'full_name',
          case when is_owner then 'owner' else 'manager' end, is_owner)
  on conflict (user_id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- парки ----------
create table public.parks (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  fleet_park_id text not null unique,
  active boolean not null default true,
  last_sync_at timestamptz,
  last_sync_error text,
  tx_synced_until timestamptz,
  created_at timestamptz not null default now()
);

create table private.park_keys (
  park_id uuid primary key references public.parks on delete cascade,
  client_id text not null,
  api_key text not null
);

-- ---------- водители (текущее состояние из Fleet API) ----------
create table public.drivers (
  id text primary key,
  park_id uuid not null references public.parks on delete cascade,
  last_name text,
  first_name text,
  middle_name text,
  phone text,
  work_status text,
  current_status text,
  status_updated_at timestamptz,
  balance numeric(12, 2) not null default 0,
  last_transaction_at timestamptz,
  hire_date date,
  car text,
  car_number text,
  updated_at timestamptz not null default now()
);
create index drivers_park_idx on public.drivers (park_id);
create index drivers_balance_idx on public.drivers (balance);

-- ---------- история балансов: последний баланс за каждый день ----------
create table public.balance_snapshots (
  day date not null,
  driver_id text not null,
  park_id uuid not null references public.parks on delete cascade,
  balance numeric(12, 2) not null,
  primary key (day, driver_id)
);
create index balance_snapshots_driver_idx on public.balance_snapshots (driver_id, day desc);
create index balance_snapshots_park_idx on public.balance_snapshots (park_id, day);

-- ---------- транзакции ----------
create table public.transactions (
  id text primary key,
  park_id uuid not null references public.parks on delete cascade,
  driver_id text,
  event_at timestamptz not null,
  category_id text,
  category_name text,
  group_id text,
  amount numeric(12, 2) not null,
  description text,
  created_by text,
  order_short_id bigint
);
create index transactions_park_event_idx on public.transactions (park_id, event_at desc);
create index transactions_driver_event_idx on public.transactions (driver_id, event_at desc);
create index transactions_group_event_idx on public.transactions (group_id, event_at desc);

-- ---------- CRM: работа с долгом ----------
create table public.driver_crm (
  driver_id text primary key references public.drivers on delete cascade,
  status text not null default 'new'
    check (status in ('new', 'contacted', 'promised', 'no_answer', 'refused', 'legal', 'closed')),
  promise_date date,
  promise_amount numeric(12, 2),
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid()
);

create table public.driver_notes (
  id bigint generated always as identity primary key,
  driver_id text not null references public.drivers on delete cascade,
  kind text not null default 'comment' check (kind in ('comment', 'call', 'promise', 'payment', 'status')),
  text text not null,
  author uuid default auth.uid(),
  author_name text,
  created_at timestamptz not null default now()
);
create index driver_notes_driver_idx on public.driver_notes (driver_id, created_at desc);

create or replace function public.set_note_author() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.author := auth.uid();
  new.author_name := (select coalesce(full_name, email) from public.staff where user_id = auth.uid());
  return new;
end;
$$;
create trigger driver_notes_author before insert on public.driver_notes
  for each row execute function public.set_note_author();

create or replace function public.touch_crm() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end;
$$;
create trigger driver_crm_touch before insert or update on public.driver_crm
  for each row execute function public.touch_crm();

-- ---------- RLS ----------
alter table public.staff enable row level security;
alter table public.parks enable row level security;
alter table public.drivers enable row level security;
alter table public.balance_snapshots enable row level security;
alter table public.transactions enable row level security;
alter table public.driver_crm enable row level security;
alter table public.driver_notes enable row level security;

create policy "staff read" on public.staff for select to authenticated
  using (user_id = auth.uid() or public.is_staff());
create policy "owner manages staff" on public.staff for update to authenticated
  using (public.is_owner()) with check (public.is_owner());
create policy "owner deletes staff" on public.staff for delete to authenticated
  using (public.is_owner() and user_id <> auth.uid());

create policy "staff read parks" on public.parks for select to authenticated using (public.is_staff());
create policy "staff read drivers" on public.drivers for select to authenticated using (public.is_staff());
create policy "staff read snapshots" on public.balance_snapshots for select to authenticated using (public.is_staff());
create policy "staff read transactions" on public.transactions for select to authenticated using (public.is_staff());

create policy "staff read crm" on public.driver_crm for select to authenticated using (public.is_staff());
create policy "staff insert crm" on public.driver_crm for insert to authenticated with check (public.is_staff());
create policy "staff update crm" on public.driver_crm for update to authenticated
  using (public.is_staff()) with check (public.is_staff());

create policy "staff read notes" on public.driver_notes for select to authenticated using (public.is_staff());
create policy "staff add notes" on public.driver_notes for insert to authenticated with check (public.is_staff());
create policy "author deletes note" on public.driver_notes for delete to authenticated
  using (author = auth.uid() or public.is_owner());

-- ---------- представления для интерфейса (с правами того, кто смотрит) ----------
create view public.driver_list with (security_invoker = true) as
select
  d.*,
  p.name as park_name,
  c.status as crm_status,
  c.promise_date,
  c.promise_amount,
  w.balance as balance_week_ago,
  n.text as last_note,
  n.created_at as last_note_at
from public.drivers d
join public.parks p on p.id = d.park_id
left join public.driver_crm c on c.driver_id = d.id
left join public.balance_snapshots w on w.driver_id = d.id and w.day = (now() at time zone 'Europe/Moscow')::date - 7
left join lateral (
  select text, created_at from public.driver_notes
  where driver_id = d.id order by created_at desc limit 1
) n on true;

create view public.park_summary with (security_invoker = true) as
select
  p.id, p.name, p.active, p.last_sync_at, p.last_sync_error, p.tx_synced_until,
  count(d.id) as drivers_total,
  count(d.id) filter (where d.work_status = 'working') as drivers_working,
  count(d.id) filter (where d.current_status in ('free', 'busy', 'in_order')) as online,
  count(d.id) filter (where d.current_status = 'free') as online_free,
  count(d.id) filter (where d.current_status = 'in_order') as online_in_order,
  count(d.id) filter (where d.current_status = 'busy') as online_busy,
  coalesce(sum(d.balance) filter (where d.balance > 0), 0) as plus_sum,
  count(d.id) filter (where d.balance > 0) as plus_count,
  coalesce(sum(d.balance) filter (where d.balance < 0), 0) as minus_sum,
  count(d.id) filter (where d.balance < 0) as minus_count
from public.parks p
left join public.drivers d on d.park_id = p.id
group by p.id;

create view public.daily_balance with (security_invoker = true) as
select
  s.day, s.park_id,
  coalesce(sum(s.balance) filter (where s.balance > 0), 0) as plus_sum,
  coalesce(sum(s.balance) filter (where s.balance < 0), 0) as minus_sum,
  count(*) filter (where s.balance < 0) as minus_count,
  count(*) filter (where s.balance <= -5000) as debtors_5000
from public.balance_snapshots s
group by s.day, s.park_id;

-- финансы: суммы по дням и категориям за период
create or replace function public.finance_by_day(
  p_from timestamptz, p_to timestamptz, p_park uuid default null, p_tz text default 'Europe/Moscow'
) returns table (day date, park_id uuid, group_id text, category_id text, category_name text, amount numeric, cnt bigint)
language sql stable security invoker set search_path = '' as $$
  select (t.event_at at time zone p_tz)::date, t.park_id, t.group_id, t.category_id,
         max(t.category_name), sum(t.amount), count(*)
  from public.transactions t
  where t.event_at >= p_from and t.event_at < p_to
    and (p_park is null or t.park_id = p_park)
  group by 1, 2, 3, 4;
$$;

-- изменения долгов между двумя днями: кто стал должником, кто погасил
create or replace function public.debt_changes(p_day date, p_threshold numeric default 5000)
returns table (driver_id text, park_id uuid, balance_before numeric, balance_after numeric, change text)
language sql stable security invoker set search_path = '' as $$
  select coalesce(a.driver_id, b.driver_id), coalesce(a.park_id, b.park_id), b.balance, a.balance,
         case when a.balance <= -p_threshold and coalesce(b.balance, 0) > -p_threshold then 'new_debtor'
              when coalesce(a.balance, 0) > -p_threshold and b.balance <= -p_threshold then 'paid_off' end
  from (select * from public.balance_snapshots where day = p_day) a
  full join (select * from public.balance_snapshots where day = p_day - 1) b on a.driver_id = b.driver_id
  where (a.balance <= -p_threshold and coalesce(b.balance, 0) > -p_threshold)
     or (coalesce(a.balance, 0) > -p_threshold and b.balance <= -p_threshold);
$$;

-- ---------- управление парками (только владелец; ключ можно записать, но не прочитать) ----------
create or replace function public.add_park(p_name text, p_fleet_park_id text, p_client_id text, p_api_key text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare new_id uuid;
begin
  if not public.is_owner() then raise exception 'Только владелец может добавлять парки'; end if;
  insert into public.parks (name, fleet_park_id) values (p_name, trim(p_fleet_park_id))
    on conflict (fleet_park_id) do update set name = excluded.name, active = true
    returning id into new_id;
  insert into private.park_keys (park_id, client_id, api_key)
    values (new_id, coalesce(nullif(trim(p_client_id), ''), 'taxi/park/' || trim(p_fleet_park_id)), trim(p_api_key))
    on conflict (park_id) do update set client_id = excluded.client_id, api_key = excluded.api_key;
  return new_id;
end;
$$;

create or replace function public.set_park_active(p_park uuid, p_active boolean) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_owner() then raise exception 'Только владелец'; end if;
  update public.parks set active = p_active where id = p_park;
end;
$$;

-- ---------- для сервера синхронизации (только service_role) ----------
create or replace function public.sync_get_parks()
returns table (id uuid, name text, fleet_park_id text, client_id text, api_key text, tx_synced_until timestamptz)
language sql security definer set search_path = '' as $$
  select p.id, p.name, p.fleet_park_id, k.client_id, k.api_key, p.tx_synced_until
  from public.parks p join private.park_keys k on k.park_id = p.id
  where p.active;
$$;

create or replace function public.sync_secret() returns text
language sql security definer set search_path = '' as $$
  select value from private.settings where key = 'sync_secret';
$$;

revoke execute on function public.sync_get_parks() from public, anon, authenticated;
revoke execute on function public.sync_secret() from public, anon, authenticated;
grant execute on function public.sync_get_parks() to service_role;
grant execute on function public.sync_secret() to service_role;
revoke execute on function public.add_park(text, text, text, text) from public, anon;
revoke execute on function public.set_park_active(uuid, boolean) from public, anon;
revoke execute on function public.handle_new_user() from public, anon, authenticated;
