-- AMA Toolkit: coloured belt grading, update 9 (check-in on the day, signed off by a teacher)
-- Run once in Supabase > SQL Editor, after coloured-belts-8.sql. Safe to run again.
-- On the grading day a teacher taps each student in on the iPad as they arrive. When everyone is in, the teacher signs
-- off the check-in with their name and signature: anyone not checked in is marked a no-show, and the check-in is locked.
-- Teachers (instructors) and grading staff can check in and sign off; grading staff can reopen a signed-off check-in.

alter table public.cb_entries add column if not exists checked_in_at timestamptz;
alter table public.cb_entries add column if not exists checked_in_by text;
alter table public.cb_entries add column if not exists no_show boolean not null default false;

alter table public.cb_days add column if not exists signed_off_at timestamptz;
alter table public.cb_days add column if not exists signed_off_by text;      -- the login that signed off
alter table public.cb_days add column if not exists signed_off_name text;    -- the teacher's name as they typed it
alter table public.cb_days add column if not exists signed_off_sig text;     -- their signature (a small PNG image)

-- Check a student in ('in'), mark them a no-show ('no_show'), or clear it ('clear')
create or replace function public.cb_check_in(p_entry uuid, p_state text)
returns void language plpgsql security definer set search_path = public as $$
declare v_day uuid; v_signed timestamptz;
begin
  if not public.prep_has_role('instructor', 'grading') then raise exception 'Only teachers and grading staff can check students in.'; end if;
  if p_state not in ('in', 'no_show', 'clear') then raise exception 'Unknown check-in state.'; end if;
  select e.day_id, d.signed_off_at into v_day, v_signed from cb_entries e join cb_days d on d.day_id = e.day_id where e.entry_id = p_entry;
  if v_day is null then raise exception 'Student not found on this grading day.'; end if;
  if v_signed is not null then raise exception 'Check-in for this day has been signed off. Ask grading staff to reopen it.'; end if;
  update cb_entries set
    checked_in_at = case when p_state = 'in' then now() end,
    checked_in_by = case when p_state = 'in' then public.prep_email() end,
    no_show = (p_state = 'no_show')
  where entry_id = p_entry;
end $$;

-- A teacher signs off the day's check-in: everyone not checked in becomes a no-show
create or replace function public.cb_sign_off(p_day uuid, p_name text, p_sig text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare n_in int; n_no int;
begin
  if not public.prep_has_role('instructor', 'grading') then raise exception 'Only teachers and grading staff can sign off check-in.'; end if;
  if coalesce(btrim(p_name), '') = '' then raise exception 'Type your name to sign off.'; end if;
  if coalesce(p_sig, '') !~ '^data:image/png;base64,[A-Za-z0-9+/=]+$' or length(p_sig) > 300000 then raise exception 'Please sign in the box.'; end if;
  if not exists (select 1 from cb_days where day_id = p_day) then raise exception 'Grading day not found.'; end if;
  if exists (select 1 from cb_days where day_id = p_day and signed_off_at is not null) then raise exception 'This check-in is already signed off.'; end if;
  update cb_entries set no_show = true where day_id = p_day and checked_in_at is null;
  update cb_days set signed_off_at = now(), signed_off_by = public.prep_email(), signed_off_name = left(btrim(p_name), 80), signed_off_sig = p_sig where day_id = p_day;
  select count(*) filter (where checked_in_at is not null), count(*) filter (where no_show) into n_in, n_no from cb_entries where day_id = p_day;
  return jsonb_build_object('checked_in', n_in, 'no_shows', n_no);
end $$;

-- Grading staff reopen a signed-off check-in (no-shows stay marked until changed)
create or replace function public.cb_reopen_check_in(p_day uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.prep_has_role('grading') then raise exception 'Only grading staff can reopen check-in.'; end if;
  update cb_days set signed_off_at = null, signed_off_by = null, signed_off_name = null, signed_off_sig = null where day_id = p_day;
end $$;

revoke all on function public.cb_check_in(uuid, text) from public, anon;
revoke all on function public.cb_sign_off(uuid, text, text) from public, anon;
revoke all on function public.cb_reopen_check_in(uuid) from public, anon;
grant execute on function public.cb_check_in(uuid, text) to authenticated;
grant execute on function public.cb_sign_off(uuid, text, text) to authenticated;
grant execute on function public.cb_reopen_check_in(uuid) to authenticated;
