-- Бот для водителей: вход по телефону, цена смены у каждого водителя, покупка смены (разовое списание),
-- отключение не раньше чем через 6 дней.

-- цена смены — своя у каждого водителя, ставит сотрудник в CRM
create table public.shift_prices (
  driver_id text primary key references public.drivers on delete cascade,
  price numeric(12, 2) not null check (price > 0),
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid()
);

-- смены
create table public.shifts (
  id uuid primary key default gen_random_uuid(),
  driver_id text not null references public.drivers on delete cascade,
  park_id uuid not null references public.parks on delete cascade,
  price numeric(12, 2) not null,
  status text not null default 'pending' check (status in ('pending', 'active', 'ended', 'failed')),
  started_at timestamptz not null default now(),
  min_end_at timestamptz not null default now() + interval '6 days',
  ended_at timestamptz,
  error text,
  telegram_id bigint
);
-- у водителя не может быть двух незавершённых смен (защита от двойного списания)
create unique index shifts_one_open on public.shifts (driver_id) where status in ('pending', 'active');
create index shifts_driver_idx on public.shifts (driver_id, started_at desc);

-- кто из водителей вошёл в бота
create table public.driver_telegram (
  telegram_id bigint primary key,
  driver_id text not null references public.drivers on delete cascade,
  phone text not null,
  linked_at timestamptz not null default now()
);
create index driver_telegram_driver_idx on public.driver_telegram (driver_id);

alter table public.shift_prices enable row level security;
alter table public.shifts enable row level security;
alter table public.driver_telegram enable row level security;

create policy "staff read prices" on public.shift_prices for select to authenticated using (public.is_staff());
create policy "staff insert prices" on public.shift_prices for insert to authenticated with check (public.is_staff());
create policy "staff update prices" on public.shift_prices for update to authenticated
  using (public.is_staff()) with check (public.is_staff());
create policy "staff delete prices" on public.shift_prices for delete to authenticated using (public.is_staff());
create policy "staff read shifts" on public.shifts for select to authenticated using (public.is_staff());
create policy "staff read telegram" on public.driver_telegram for select to authenticated using (public.is_staff());

create or replace function public.touch_shift_price() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end;
$$;
create trigger shift_prices_touch before insert or update on public.shift_prices
  for each row execute function public.touch_shift_price();
revoke execute on function public.touch_shift_price() from public, anon, authenticated;

-- ---------- для функции бота (только service_role) ----------

-- водители с этим номером (по последним 10 цифрам), кроме уволенных
create or replace function public.driver_bot_find(p_phone text)
returns setof public.drivers
language sql stable security definer set search_path = '' as $$
  select d.* from public.drivers d
  where right(regexp_replace(coalesce(d.phone, ''), '\D', '', 'g'), 10) = right(regexp_replace(p_phone, '\D', '', 'g'), 10)
    and length(regexp_replace(p_phone, '\D', '', 'g')) >= 10
    and coalesce(d.work_status, '') <> 'fired';
$$;

create or replace function public.driver_bot_settings()
returns table (token text, webhook_secret text)
language sql stable security definer set search_path = '' as $$
  select (select value from private.settings where key = 'driver_bot_token'),
         (select value from private.settings where key = 'driver_bot_webhook_secret');
$$;

revoke execute on function public.driver_bot_find(text) from public, anon, authenticated;
revoke execute on function public.driver_bot_settings() from public, anon, authenticated;
grant execute on function public.driver_bot_find(text) to service_role;
grant execute on function public.driver_bot_settings() to service_role;

-- ---------- в списке водителей CRM: цена и текущая смена ----------
create or replace view public.driver_shift_info with (security_invoker = true) as
select
  d.id as driver_id,
  sp.price as shift_price,
  s.id as shift_id,
  s.status as shift_status,
  s.started_at as shift_started_at,
  s.min_end_at as shift_min_end_at,
  s.price as shift_paid,
  exists (select 1 from public.driver_telegram t where t.driver_id = d.id) as in_bot
from public.drivers d
left join public.shift_prices sp on sp.driver_id = d.id
left join public.shifts s on s.driver_id = d.id and s.status = 'active';
