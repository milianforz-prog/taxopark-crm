-- сотрудник может досрочно завершить смену водителя из CRM
create or replace function public.staff_end_shift(p_shift uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_staff() then raise exception 'Нет доступа'; end if;
  update public.shifts set status = 'ended', ended_at = now(), error = 'завершена сотрудником'
  where id = p_shift and status = 'active';
end;
$$;
revoke execute on function public.staff_end_shift(uuid) from public, anon;
grant execute on function public.staff_end_shift(uuid) to authenticated;
