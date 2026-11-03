-- администраторы бота водителей: входят по своему номеру и открывают кабинет любого водителя
alter table public.driver_telegram add column is_admin boolean not null default false;
alter table public.driver_telegram alter column driver_id drop not null;

-- номера администраторов через запятую
insert into private.settings (key, value) values ('driver_bot_admin_phones', '15155371949')
on conflict (key) do update set value = excluded.value;

drop function public.driver_bot_settings();
create function public.driver_bot_settings()
returns table (token text, webhook_secret text, admin_phones text)
language sql stable security definer set search_path = '' as $$
  select (select value from private.settings where key = 'driver_bot_token'),
         (select value from private.settings where key = 'driver_bot_webhook_secret'),
         (select value from private.settings where key = 'driver_bot_admin_phones');
$$;
revoke execute on function public.driver_bot_settings() from public, anon, authenticated;
grant execute on function public.driver_bot_settings() to service_role;
