-- TV display: database setup
-- Run in Supabase > SQL Editor (choose "with RLS" if asked). Safe to run again.
--
-- Slides for the dojang TV. Staff (anyone with a permission in AMA ID Cards other than the print
-- station, or a role in Black Belt Prep) edit them on the editor page. The TV itself doesn't sign in:
-- it shows the slideshow once the screen code (Settings on the editor page) is entered, and only
-- gets what's on screen (slides, plus the live AMA info below).
--
-- Live slides fill themselves in from Black Belt Prep:
--   next_grading  the next grading date of the active cycle
--   sessions      the next prep session dates (sign-off marked)
--   congrats      students who passed a grading in the last 45 days, with their new rank
--
-- Party mode: the TV shows only one slide (e.g. a birthday message) until a set time, then goes back to
-- the normal slideshow by itself. That slide is kept out of the normal slideshow so it can be reused.

-- ---------- Who can edit ----------
create or replace function public.tv_is_staff() returns boolean
  language plpgsql stable security definer set search_path = public as $$
declare me text := lower(auth.jwt() ->> 'email'); yes boolean := false;
begin
  if me is null then return false; end if;
  if to_regclass('public.staff_permissions') is not null then
    execute 'select exists (select 1 from public.staff_permissions where email = $1 and permission <> ''printer'')' into yes using me;
    if yes then return true; end if;
  end if;
  if to_regclass('public.prep_roles') is not null then
    execute 'select exists (select 1 from public.prep_roles where email = $1)' into yes using me;
  end if;
  return yes;
end $$;
grant execute on function public.tv_is_staff() to authenticated;

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
alter table public.tv_settings drop constraint if exists tv_settings_code_check;
alter table public.tv_settings add constraint tv_settings_code_check check (screen_code ~ '^[A-Z0-9]{4,12}$');

-- ---------- Slides ----------
create table if not exists public.tv_slides (
  id          uuid primary key default gen_random_uuid(),
  kind        text not null check (kind in ('photo', 'video', 'text', 'live')),
  title       text,
  body        text,
  media_path  text,                 -- file in the "tv" storage bucket (photos, videos, info slide backgrounds)
  theme       text not null default 'green',
  live_kind   text check (live_kind in ('next_grading', 'sessions', 'congrats')),
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
begin new.updated_at := now(); new.screen_code := upper(new.screen_code); return new; end $$;
drop trigger if exists tv_settings_stamp on public.tv_settings;
create trigger tv_settings_stamp before update on public.tv_settings for each row execute function public.tv_settings_stamp();

alter table public.tv_settings enable row level security;
alter table public.tv_slides   enable row level security;
drop policy if exists "staff edit tv settings" on public.tv_settings;
drop policy if exists "staff edit tv slides" on public.tv_slides;
create policy "staff edit tv settings" on public.tv_settings for all to authenticated using (public.tv_is_staff()) with check (public.tv_is_staff());
create policy "staff edit tv slides"   on public.tv_slides   for all to authenticated using (public.tv_is_staff()) with check (public.tv_is_staff());

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

-- ---------- What the TV gets (no sign-in, screen code only) ----------
create or replace function public.tv_feed(p_code text) returns jsonb
  language plpgsql stable security definer set search_path = public as $$
declare
  s public.tv_settings%rowtype;
  today date := (now() at time zone 'Australia/Sydney')::date;
  slides jsonb; live jsonb := '{}'::jsonb; v jsonb; changed timestamptz; one_slide jsonb;
begin
  select * into s from public.tv_settings where id = 1;
  if not found or upper(trim(coalesce(p_code, ''))) <> s.screen_code then
    return jsonb_build_object('error', 'wrong_code');
  end if;

  -- Party mode: just the one slide, until the set time
  if s.only_slide is not null and s.only_until > now() then
    select jsonb_build_object('id', t.id, 'kind', t.kind, 'title', t.title, 'body', t.body, 'media_path', t.media_path,
             'theme', t.theme, 'live_kind', t.live_kind, 'seconds', t.seconds)
      into one_slide from public.tv_slides t where t.id = s.only_slide;
  end if;
  if one_slide is not null then
    return jsonb_build_object(
      'settings', jsonb_build_object('seconds', s.seconds, 'show_clock', false, 'show_logo', false),
      'version', s.updated_at, 'slides', jsonb_build_array(one_slide), 'live', '{}'::jsonb, 'today', today,
      'only', true, 'only_until', s.only_until);
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', t.id, 'kind', t.kind, 'title', t.title, 'body', t.body, 'media_path', t.media_path,
           'theme', t.theme, 'live_kind', t.live_kind, 'seconds', t.seconds) order by t.position, t.created_at), '[]'::jsonb),
         max(t.updated_at)
    into slides, changed
    from public.tv_slides t
   where t.enabled and not t.party and (t.starts_on is null or t.starts_on <= today) and (t.ends_on is null or t.ends_on >= today);

  -- Live AMA info (only if Black Belt Prep is set up in this project)
  if to_regclass('public.prep_cycles') is not null then
    execute $q$
      select jsonb_build_object('cycle', c.name, 'date', c.grading_date)
        from public.prep_cycles c
       where c.status = 'active' and c.grading_date >= $1
       order by c.grading_date limit 1 $q$ into v using today;
    live := live || jsonb_build_object('next_grading', v);

    execute $q$
      select coalesce(jsonb_agg(x order by x->>'date'), '[]'::jsonb) from (
        select jsonb_build_object('date', se.session_date, 'number', se.session_number,
                 'signoff', se.session_number = (select max(s2.session_number) from public.prep_sessions s2 where s2.cycle_id = se.cycle_id)) x
          from public.prep_sessions se join public.prep_cycles c on c.cycle_id = se.cycle_id
         where c.status = 'active' and se.session_date >= $1
         order by se.session_date limit 4) q $q$ into v using today;
    live := live || jsonb_build_object('sessions', v);

    execute $q$
      select coalesce(jsonb_agg(jsonb_build_object('name', n, 'rank', r) order by n), '[]'::jsonb) from (
        select distinct coalesce(nullif(trim(st.certificate_name), ''), st.full_name) n, g.target_rank r
          from public.prep_grading g
          join public.prep_students st on st.student_id = g.student_id
          left join public.prep_cycles c on c.cycle_id = g.cycle_id
         where g.result = 'passed' and not st.is_test
           and coalesce(g.grading_date, c.grading_date) between $1 - 45 and $1) q $q$ into v using today;
    live := live || jsonb_build_object('congrats', v);
  end if;

  return jsonb_build_object(
    'settings', jsonb_build_object('seconds', s.seconds, 'show_clock', s.show_clock, 'show_logo', s.show_logo),
    'version', greatest(coalesce(changed, s.updated_at), s.updated_at),
    'slides', slides, 'live', live, 'today', today);
end $$;
grant execute on function public.tv_feed(text) to anon, authenticated;

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
