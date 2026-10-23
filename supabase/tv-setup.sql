-- TV display: database setup
-- Run in Supabase > SQL Editor (choose "with RLS" if asked). Safe to run again.
--
-- Slides for the dojang TV. Staff with the TV editor ticked (see "Who can use the TV" below) edit them on
-- the editor page. The TV itself doesn't sign in:
-- it shows the slideshow once the screen code (Settings on the editor page) is entered, and only
-- gets what's on screen (slides, plus the live AMA info below).
--
-- Live slides fill themselves in:
--   next_grading  the next grading date of the active cycle (from Black Belt Prep)
--   events        this month's events (and next month's near the end of the month), from tv_events
--   month         "This is the Month of ...", from tv_months
--
-- Countdown slides: "Black belt grading in 12 days", to a set date or the next grading in Black Belt Prep.
-- They stop showing once the day has passed.
--
-- Booked parties: party mode switches on and off by itself at the booked times.
--
-- TV status: the TV checks in every 20 seconds (tv_checkin) with what it's showing, so the editor can show
-- whether it's online. "Refresh the TV" in the editor asks it to reload.
--
-- Party mode: the TV shows only one slide (e.g. a birthday message) until a set time, then goes back to
-- the normal slideshow by itself. That slide is kept out of the normal slideshow so it can be reused.

-- ---------- Who can use the TV ----------
-- TV permissions, ticked on the Staff logins page (staff/):
--   edit     the TV editor: slides, party mode, events, settings (and the remote)
--   remote   only the phone remote
-- Admins in AMA ID Cards or Black Belt Prep can always do everything. Someone with only TV ticks can't open
-- AMA ID Cards or Black Belt Prep.
do $$
begin
  if to_regclass('public.tv_permissions') is null then
    create table public.tv_permissions (
      email      text not null,
      permission text not null check (permission in ('edit', 'remote')),
      created_at timestamptz not null default now(),
      primary key (email, permission)
    );
    -- First run: everyone who could edit the TV before keeps it
    if to_regclass('public.staff_permissions') is not null then
      execute $q$ insert into public.tv_permissions (email, permission)
        select distinct lower(email), 'edit' from public.staff_permissions where permission <> 'printer' on conflict do nothing $q$;
    end if;
    if to_regclass('public.prep_roles') is not null then
      execute $q$ insert into public.tv_permissions (email, permission)
        select distinct lower(email), 'edit' from public.prep_roles on conflict do nothing $q$;
    end if;
  end if;
end $$;

-- Can the signed-in person do this on the TV? ('edit' or 'remote'; edit includes the remote; 'admin' = an admin in either app)
create or replace function public.tv_can(p_perm text) returns boolean
  language plpgsql stable security definer set search_path = public as $$
declare me text := lower(auth.jwt() ->> 'email'); yes boolean := false;
begin
  if me is null then return false; end if;
  if to_regclass('public.staff_permissions') is not null then
    execute 'select exists (select 1 from public.staff_permissions where email = $1 and permission = ''admin'')' into yes using me;
    if yes then return true; end if;
  end if;
  if to_regclass('public.prep_roles') is not null then
    execute 'select exists (select 1 from public.prep_roles where email = $1 and role = ''admin'')' into yes using me;
    if yes then return true; end if;
  end if;
  if p_perm = 'admin' then return false; end if;   -- only the apps' admins manage TV permissions
  return exists (select 1 from public.tv_permissions where email = me and (permission = p_perm or permission = 'edit'));
end $$;
grant execute on function public.tv_can(text) to authenticated;
create or replace function public.tv_is_staff() returns boolean   -- can use the TV editor
  language sql stable security definer set search_path = public as $$ select public.tv_can('edit') $$;
grant execute on function public.tv_is_staff() to authenticated;

alter table public.tv_permissions enable row level security;
drop policy if exists "see own tv permissions" on public.tv_permissions;
drop policy if exists "admins manage tv permissions" on public.tv_permissions;
create policy "see own tv permissions" on public.tv_permissions for select to authenticated
  using (email = lower(auth.jwt() ->> 'email') or public.tv_can('admin'));
create policy "admins manage tv permissions" on public.tv_permissions for all to authenticated
  using (public.tv_can('admin')) with check (public.tv_can('admin'));

-- ---------- Settings ----------
create table if not exists public.tv_settings (
  id          int primary key default 1 check (id = 1),
  screen_code text not null default upper(substr(md5(random()::text), 1, 6)),
  seconds     int not null default 10 check (seconds between 3 and 600),
  show_clock  boolean not null default true,
  show_logo   boolean not null default true,
  updated_at  timestamptz not null default now()
);
insert into public.tv_settings (id) values (1) on conflict (id) do nothing;
alter table public.tv_settings add column if not exists only_slide uuid;          -- party mode: the one slide to show
alter table public.tv_settings add column if not exists only_until timestamptz;   -- ... until this time
alter table public.tv_settings add column if not exists reload_at timestamptz;    -- "Refresh the TV" was pressed at this time
alter table public.tv_settings add column if not exists quiet_on boolean not null default false;   -- quiet hours: no slideshow at night
alter table public.tv_settings add column if not exists quiet_from time not null default '21:00';
alter table public.tv_settings add column if not exists quiet_to time not null default '07:00';
alter table public.tv_settings add column if not exists quiet_style text not null default 'logo';
-- Each day's slideshow hours, e.g. {"1": {"on": "15:00", "off": "21:00"}, "0": null} (0 = Sunday ... 6 = Saturday; null = closed all day).
-- Outside them the TV is quiet. Empty: the same quiet_from/quiet_to every day.
alter table public.tv_settings add column if not exists quiet_days jsonb;
alter table public.tv_settings drop constraint if exists tv_settings_quiet_check;
alter table public.tv_settings add constraint tv_settings_quiet_check check (quiet_style in ('black', 'logo'));
alter table public.tv_settings add column if not exists remote_until timestamptz;               -- phone remote: the TV listens closely until then
alter table public.tv_settings add column if not exists remote_seq bigint not null default 0;     -- ... numbers each button press
alter table public.tv_settings add column if not exists remote_cmd jsonb;                         -- ... the last press, e.g. {"cmd": "next"}
alter table public.tv_settings add column if not exists remote_at timestamptz;
alter table public.tv_settings drop constraint if exists tv_settings_code_check;
alter table public.tv_settings add constraint tv_settings_code_check check (screen_code ~ '^[A-Z0-9]{4,12}$');

-- ---------- Slides ----------
create table if not exists public.tv_slides (
  id          uuid primary key default gen_random_uuid(),
  kind        text not null,
  title       text,
  body        text,
  media_path  text,                 -- file in the "tv" storage bucket (photos, videos, info slide backgrounds)
  theme       text not null default 'green',
  live_kind   text check (live_kind in ('next_grading', 'events', 'month')),
  seconds     int check (seconds is null or seconds between 3 and 600),   -- blank = the default
  position    int not null,         -- filled in automatically: new slides go at the end
  enabled     boolean not null default true,
  starts_on   date,
  ends_on     date,
  created_by  text,
  updated_by  text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  check (kind <> 'live' or live_kind is not null),
  check (kind not in ('photo', 'video') or media_path is not null),
  check (ends_on is null or starts_on is null or ends_on >= starts_on)
);
create index if not exists tv_slides_position_idx on public.tv_slides (position);
alter table public.tv_slides drop constraint if exists tv_slides_theme_check;
alter table public.tv_slides add constraint tv_slides_theme_check check (theme in ('green', 'dark', 'gold', 'light', 'party'));
alter table public.tv_slides add column if not exists party boolean not null default false;   -- made for party mode
alter table public.tv_slides add column if not exists event_on date;                           -- countdown: the day it counts to
alter table public.tv_slides add column if not exists count_to text;                           -- countdown: 'date' or 'grading'
alter table public.tv_slides drop constraint if exists tv_slides_kind_check;
alter table public.tv_slides add constraint tv_slides_kind_check check (kind in ('photo', 'video', 'text', 'live', 'countdown', 'qr'));
alter table public.tv_slides add column if not exists link text;   -- QR code slides: the link the code opens
alter table public.tv_slides drop constraint if exists tv_slides_qr_check;
alter table public.tv_slides add constraint tv_slides_qr_check check (kind <> 'qr' or (link ~* '^https?://' and media_path is not null));
alter table public.tv_slides drop constraint if exists tv_slides_countdown_check;
delete from public.tv_slides where kind = 'live' and live_kind in ('congrats', 'sessions');   -- these slides were removed
alter table public.tv_slides drop constraint if exists tv_slides_live_kind_check;
alter table public.tv_slides add constraint tv_slides_live_kind_check check (live_kind in ('next_grading', 'events', 'month'));
alter table public.tv_slides add constraint tv_slides_countdown_check check (kind <> 'countdown' or count_to = 'grading' or (count_to = 'date' and event_on is not null));

-- ---------- Booked parties ----------
create table if not exists public.tv_party_bookings (
  id          uuid primary key default gen_random_uuid(),
  slide_id    uuid not null references public.tv_slides on delete cascade,
  starts_at   timestamptz not null,
  ends_at     timestamptz not null check (ends_at > starts_at),
  created_by  text default lower(auth.jwt() ->> 'email'),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists tv_party_bookings_time_idx on public.tv_party_bookings (starts_at);
alter table public.tv_party_bookings enable row level security;
drop policy if exists "staff edit party bookings" on public.tv_party_bookings;
create policy "staff edit party bookings" on public.tv_party_bookings for all to authenticated using (public.tv_is_staff()) with check (public.tv_is_staff());

-- ---------- TV status ----------
create table if not exists public.tv_screens (
  screen_id   text primary key,          -- made up by each TV the first time it starts
  last_seen   timestamptz not null default now(),
  started_at  timestamptz,               -- when its page last loaded
  showing     text,                      -- what's on screen now
  details     jsonb not null default '{}'::jsonb
);
alter table public.tv_screens add column if not exists loaded_at timestamptz;   -- server time of the first check-in after the page loaded
alter table public.tv_screens enable row level security;
drop policy if exists "staff see screens" on public.tv_screens;
drop policy if exists "staff remove screens" on public.tv_screens;
create policy "staff see screens" on public.tv_screens for select to authenticated using (public.tv_can('remote'));
create policy "staff remove screens" on public.tv_screens for delete to authenticated using (public.tv_is_staff());
alter table public.tv_slides alter column position drop default;

create or replace function public.tv_stamp() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    new.created_by := lower(auth.jwt() ->> 'email');
    if new.position is null then select coalesce(max(position), 0) + 1 into new.position from public.tv_slides; end if;
  end if;
  new.updated_by := lower(auth.jwt() ->> 'email');
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists tv_stamp on public.tv_slides;
create trigger tv_stamp before insert or update on public.tv_slides for each row execute function public.tv_stamp();
create or replace function public.tv_settings_stamp() returns trigger language plpgsql as $$
begin
  if new.remote_seq is distinct from old.remote_seq then return new; end if;   -- a remote button press isn't a change to the slideshow
  new.updated_at := now(); new.screen_code := upper(new.screen_code);
  if new.reload_at is distinct from old.reload_at and new.reload_at is not null then new.reload_at := now(); end if;   -- server time, so TV clocks don't matter
  return new;
end $$;
drop trigger if exists tv_settings_stamp on public.tv_settings;
create trigger tv_settings_stamp before update on public.tv_settings for each row execute function public.tv_settings_stamp();

alter table public.tv_settings enable row level security;
alter table public.tv_slides   enable row level security;
drop policy if exists "staff edit tv settings" on public.tv_settings;
drop policy if exists "staff edit tv slides" on public.tv_slides;
create policy "staff edit tv settings" on public.tv_settings for all to authenticated using (public.tv_is_staff()) with check (public.tv_is_staff());
create policy "staff edit tv slides"   on public.tv_slides   for all to authenticated using (public.tv_is_staff()) with check (public.tv_is_staff());
drop policy if exists "remote sees tv slides" on public.tv_slides;
create policy "remote sees tv slides" on public.tv_slides for select to authenticated using (public.tv_can('remote'));

-- ---------- Birthday poster templates ----------
-- A design with the name area left empty, plus where the name goes and how it looks (see tv/poster.js).
-- Staff type a name in the editor; the poster is drawn there and shown with party mode.
create table if not exists public.tv_poster_templates (
  id          uuid primary key default gen_random_uuid(),
  title       text not null check (length(trim(title)) > 0),
  image_path  text not null,          -- in the "tv" storage bucket
  settings    jsonb not null,
  position    int not null default 0,
  created_by  text default lower(auth.jwt() ->> 'email'),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
alter table public.tv_poster_templates enable row level security;
drop policy if exists "staff edit poster templates" on public.tv_poster_templates;
create policy "staff edit poster templates" on public.tv_poster_templates for all to authenticated using (public.tv_is_staff()) with check (public.tv_is_staff());

-- ---------- Events calendar (the "Events this month" live slide) ----------
create table if not exists public.tv_events (
  id          uuid primary key default gen_random_uuid(),
  starts_on   date not null,
  ends_on     date check (ends_on is null or ends_on >= starts_on),   -- empty: a one-day event
  title       text not null check (length(trim(title)) > 0),
  note        text,                                                    -- e.g. "1:30 pm, Marrickville"
  created_by  text default lower(auth.jwt() ->> 'email'),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists tv_events_dates_idx on public.tv_events (starts_on);
create table if not exists public.tv_months (       -- e.g. October: "Month of Health & Nutrition"
  month       date primary key check (extract(day from month) = 1),
  theme       text not null check (length(trim(theme)) > 0)
);
alter table public.tv_events enable row level security;
alter table public.tv_months enable row level security;
drop policy if exists "staff edit events" on public.tv_events;
drop policy if exists "staff edit months" on public.tv_months;
create policy "staff edit events" on public.tv_events for all to authenticated using (public.tv_is_staff()) with check (public.tv_is_staff());
create policy "staff edit months" on public.tv_months for all to authenticated using (public.tv_is_staff()) with check (public.tv_is_staff());

-- ---------- What the TV gets (no sign-in, screen code only) ----------
create or replace function public.tv_feed(p_code text) returns jsonb
  language plpgsql stable security definer set search_path = public as $$
declare
  s public.tv_settings%rowtype;
  today date := (now() at time zone 'Australia/Sydney')::date;
  slides jsonb; live jsonb := '{}'::jsonb; v jsonb; changed timestamptz; one_slide jsonb;
  one_id uuid; one_until timestamptz; one_changed timestamptz;
  m0 date := date_trunc('month', (now() at time zone 'Australia/Sydney'))::date;   -- this month
  m1 date := (date_trunc('month', (now() at time zone 'Australia/Sydney')) + interval '1 month')::date;   -- next month
  two boolean;
  now_time time := (now() at time zone 'Australia/Sydney')::time;
  day_hours jsonb;
begin
  select * into s from public.tv_settings where id = 1;
  if not found or upper(trim(coalesce(p_code, ''))) <> s.screen_code then
    return jsonb_build_object('error', 'wrong_code');
  end if;

  -- Party mode: just the one slide, until the set time. Started now in the editor, or booked ahead.
  if s.only_slide is not null and s.only_until > now() then
    one_id := s.only_slide; one_until := s.only_until; one_changed := s.updated_at;
  else
    select b.slide_id, b.ends_at, b.updated_at into one_id, one_until, one_changed
      from public.tv_party_bookings b where b.starts_at <= now() and b.ends_at > now()
     order by b.starts_at desc limit 1;
  end if;
  if one_id is not null then
    select jsonb_build_object('id', t.id, 'kind', t.kind, 'title', t.title, 'body', t.body, 'media_path', t.media_path,
             'theme', t.theme, 'live_kind', t.live_kind, 'seconds', t.seconds)
      into one_slide from public.tv_slides t where t.id = one_id;
  end if;
  if one_slide is not null then
    return jsonb_build_object(
      'settings', jsonb_build_object('seconds', s.seconds, 'show_clock', false, 'show_logo', false),
      'version', greatest(s.updated_at, one_changed), 'slides', jsonb_build_array(one_slide), 'live', '{}'::jsonb, 'today', today,
      'only', true, 'only_until', one_until);
  end if;

  -- Quiet hours (a party still shows): a black screen or just the logo outside each day's slideshow hours
  day_hours := s.quiet_days -> extract(dow from (now() at time zone 'Australia/Sydney'))::int::text;
  if s.quiet_on and (case
       when s.quiet_days is not null then
         day_hours is null or jsonb_typeof(day_hours) <> 'object'
         or not (now_time >= (day_hours ->> 'on')::time and now_time < (day_hours ->> 'off')::time)
       else s.quiet_from <> s.quiet_to and (case when s.quiet_from < s.quiet_to
         then now_time >= s.quiet_from and now_time < s.quiet_to
         else now_time >= s.quiet_from or now_time < s.quiet_to end) end) then
    return jsonb_build_object(
      'settings', jsonb_build_object('seconds', s.seconds, 'show_clock', false, 'show_logo', false),
      'version', s.updated_at, 'slides', '[]'::jsonb, 'live', '{}'::jsonb, 'today', today,
      'quiet', s.quiet_style);
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', t.id, 'kind', t.kind, 'title', t.title, 'body', t.body, 'media_path', t.media_path,
           'theme', t.theme, 'live_kind', t.live_kind, 'seconds', t.seconds, 'event_on', t.event_on, 'count_to', t.count_to, 'link', t.link) order by t.position, t.created_at), '[]'::jsonb),
         max(t.updated_at)
    into slides, changed
    from public.tv_slides t
   where t.enabled and not t.party and (t.starts_on is null or t.starts_on <= today) and (t.ends_on is null or t.ends_on >= today)
     and not (t.kind = 'countdown' and t.count_to = 'date' and t.event_on < today);

  -- Events: what's left of this month; in the last 10 days of the month (or once this month is over), next month too
  two := today >= m1 - 10 or not exists (select 1 from public.tv_events e where coalesce(e.ends_on, e.starts_on) >= today and e.starts_on < m1);
  select coalesce(jsonb_agg(jsonb_build_object('month', q.mm, 'theme', (select mt.theme from public.tv_months mt where mt.month = q.mm), 'events', (
           select coalesce(jsonb_agg(jsonb_build_object('start', e.starts_on, 'end', e.ends_on, 'title', e.title, 'note', e.note) order by e.starts_on, e.ends_on nulls first, e.title), '[]'::jsonb)
             from public.tv_events e
            where coalesce(e.ends_on, e.starts_on) >= today
              and greatest(date_trunc('month', e.starts_on)::date, m0) = q.mm)) order by q.mm), '[]'::jsonb)
    into v from (select m0 mm union all select m1 where two) q;
  live := live || jsonb_build_object('events', v);
  select jsonb_build_object('month', mt.month, 'theme', mt.theme) into v from public.tv_months mt where mt.month = m0;
  live := live || jsonb_build_object('month', v);

  -- Live AMA info (only if Black Belt Prep is set up in this project)
  if to_regclass('public.prep_cycles') is not null then
    execute $q$
      select jsonb_build_object('cycle', c.name, 'date', c.grading_date)
        from public.prep_cycles c
       where c.status = 'active' and c.grading_date >= $1
       order by c.grading_date limit 1 $q$ into v using today;
    live := live || jsonb_build_object('next_grading', v);

  end if;

  return jsonb_build_object(
    'settings', jsonb_build_object('seconds', s.seconds, 'show_clock', s.show_clock, 'show_logo', s.show_logo),
    'remote', coalesce(s.remote_until > now(), false),
    'version', greatest(coalesce(changed, s.updated_at), s.updated_at),
    'slides', slides, 'live', live, 'today', today);
end $$;
grant execute on function public.tv_feed(text) to anon, authenticated;

-- The TV checks in: records what it's showing, and hears whether it should reload
create or replace function public.tv_checkin(p_code text, p_screen text, p_showing text, p_started timestamptz, p_details jsonb default '{}'::jsonb)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare s public.tv_settings%rowtype; loaded timestamptz;
begin
  select * into s from public.tv_settings where id = 1;
  if not found or upper(trim(coalesce(p_code, ''))) <> s.screen_code then return jsonb_build_object('error', 'wrong_code'); end if;
  if coalesce(p_screen, '') !~ '^[A-Za-z0-9_-]{6,40}$' then return jsonb_build_object('error', 'bad_screen'); end if;
  -- loaded_at is the server's time when this page load first checked in (TV clocks can be wrong)
  insert into public.tv_screens as t (screen_id, last_seen, started_at, loaded_at, showing, details)
    values (p_screen, now(), p_started, now(), left(p_showing, 200), coalesce(p_details, '{}'::jsonb))
  on conflict (screen_id) do update set last_seen = now(), started_at = excluded.started_at,
    loaded_at = case when t.started_at is distinct from excluded.started_at or t.loaded_at is null then now() else t.loaded_at end,
    showing = excluded.showing, details = excluded.details
  returning t.loaded_at into loaded;
  delete from public.tv_screens where last_seen < now() - interval '30 days';   -- forget old TVs
  return jsonb_build_object('reload', s.reload_at is not null and s.reload_at > loaded);
end $$;
grant execute on function public.tv_checkin(text, text, text, timestamptz, jsonb) to anon, authenticated;

-- ---------- Phone remote ----------
-- The phone sends a button press; while the remote is open (10 minutes since its last use) the TV checks every
-- second or two, carries out the newest press, and reports what's on screen.
create or replace function public.tv_remote_send(p_cmd text, p_slide uuid default null)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare n bigint;
begin
  if not public.tv_can('remote') then raise exception 'Your login doesn''t have the TV remote ticked' using errcode = '42501'; end if;
  if p_cmd not in ('hello', 'next', 'back', 'pause', 'play', 'show', 'done') then raise exception 'Unknown button'; end if;
  update public.tv_settings set
      remote_seq = remote_seq + 1, remote_at = now(),
      remote_cmd = jsonb_build_object('cmd', p_cmd, 'slide', p_slide),
      remote_until = case when p_cmd = 'done' then now() + interval '30 seconds' else now() + interval '10 minutes' end
   where id = 1 returning remote_seq into n;
  return jsonb_build_object('seq', n);
end $$;
revoke all on function public.tv_remote_send(text, uuid) from public, anon;
grant execute on function public.tv_remote_send(text, uuid) to authenticated;

create or replace function public.tv_remote_poll(p_code text, p_screen text, p_after bigint, p_state jsonb default '{}'::jsonb)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare s public.tv_settings%rowtype;
begin
  select * into s from public.tv_settings where id = 1;
  if not found or upper(trim(coalesce(p_code, ''))) <> s.screen_code then return jsonb_build_object('error', 'wrong_code'); end if;
  if coalesce(p_screen, '') ~ '^[A-Za-z0-9_-]{6,40}$' then   -- what's on screen, for the remote and TV status
    update public.tv_screens set last_seen = now(), showing = left(coalesce(p_state ->> 'showing', showing), 200),
           details = details || (coalesce(p_state, '{}'::jsonb) - 'showing') || jsonb_build_object('remote_seq', p_after)
     where screen_id = p_screen;
  end if;
  return jsonb_build_object('on', coalesce(s.remote_until > now(), false), 'seq', s.remote_seq,
    'cmd', case when p_after is not null and s.remote_seq > p_after and s.remote_at > now() - interval '30 seconds' then s.remote_cmd end);
end $$;
grant execute on function public.tv_remote_poll(text, text, bigint, jsonb) to anon, authenticated;

-- ---------- Photos and videos ----------
-- Files are public by link (the TV shows them without signing in); names are random, and only staff can add,
-- change or remove them. 50 MB per file (Supabase's limit on the free plan).
insert into storage.buckets (id, name, public) values ('tv', 'tv', true) on conflict (id) do update set public = true;
drop policy if exists "tv files add"    on storage.objects;
drop policy if exists "tv files change" on storage.objects;
drop policy if exists "tv files remove" on storage.objects;
drop policy if exists "tv files list"   on storage.objects;
create policy "tv files add"    on storage.objects for insert to authenticated with check (bucket_id = 'tv' and public.tv_is_staff());
create policy "tv files change" on storage.objects for update to authenticated using (bucket_id = 'tv' and public.tv_is_staff());
create policy "tv files remove" on storage.objects for delete to authenticated using (bucket_id = 'tv' and public.tv_is_staff());
create policy "tv files list"   on storage.objects for select to authenticated using (bucket_id = 'tv' and public.tv_is_staff());
