-- =====================================================================
--  Davao Mission Master Guide Registry — Supabase database
--  Paste this whole file into Supabase → SQL Editor → New query → Run.
--  Safe to run once on a new, empty project.
-- =====================================================================

-- ---------- lookup tables ----------
create table public.settings (key text primary key, value text not null default '');
create table public.clusters (name text primary key, sort int not null default 0);
create table public.stages    (id uuid primary key default gen_random_uuid(), name text not null, sort int not null default 0);
create table public.documents (id uuid primary key default gen_random_uuid(), name text not null, sort int not null default 0);
create table public.trainings (id uuid primary key default gen_random_uuid(), name text not null, sort int not null default 0);

-- ---------- Master Guides ----------
create table public.members (
  id uuid primary key default gen_random_uuid(),
  full_name text not null check (length(trim(full_name)) between 1 and 120),
  cluster text not null references public.clusters(name) on update cascade,
  district text not null default '' check (length(district) <= 80),
  church text not null default '' check (length(church) <= 120),
  training_date date,
  invested_date date,
  stage_id uuid references public.stages(id) on delete restrict,
  docs uuid[] not null default '{}',
  cert_path text not null default '',
  cert_name text not null default '',
  updated_at timestamptz not null default now(),
  updated_by text not null default ''
);
create index members_cluster_idx on public.members(cluster);

-- private contact info (never public)
create table public.member_contacts (
  member_id uuid primary key references public.members(id) on delete cascade,
  phone text not null default '' check (length(phone) <= 40),
  email text not null default '' check (length(email) <= 120)
);

-- ---------- accounts ----------
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text not null unique check (username ~ '^[a-z0-9._-]{3,40}$'),
  name text not null default '',
  role text not null check (role in ('director', 'coordinator', 'member')),
  cluster text references public.clusters(name) on update cascade,
  member_id uuid references public.members(id) on delete set null,
  status text not null default 'pending' check (status in ('pending', 'active', 'disabled')),
  must_change boolean not null default false,
  created_at timestamptz not null default now(),
  last_login timestamptz
);

-- accounts the Director prepares; the person then signs up with this username
create table public.invites (
  username text primary key check (username ~ '^[a-z0-9._-]{3,40}$'),
  name text not null default '',
  role text not null check (role in ('director', 'coordinator')),
  cluster text references public.clusters(name) on update cascade,
  created_at timestamptz not null default now()
);

-- ---------- requests (sign-ups and corrections) ----------
create table public.requests (
  id uuid primary key default gen_random_uuid(),
  type text not null check (type in ('signup', 'change')),
  user_id uuid references public.profiles(id) on delete cascade,
  member_id uuid references public.members(id) on delete cascade,
  cluster text references public.clusters(name) on update cascade,
  payload jsonb not null default '{}',
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  created_at timestamptz not null default now(),
  decided_by text not null default '',
  decided_at timestamptz,
  reply text not null default ''
);

-- ---------- personal trainings ----------
create table public.person_trainings (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references public.members(id) on delete cascade,
  cluster text references public.clusters(name) on update cascade,
  training_id uuid references public.trainings(id) on delete set null,
  custom_name text not null default '' check (length(custom_name) <= 120),
  date date,
  place text not null default '' check (length(place) <= 150),
  notes text not null default '' check (length(notes) <= 300),
  status text not null default 'pending' check (status in ('pending', 'verified', 'rejected')),
  cert_path text not null default '',
  cert_name text not null default '',
  added_by text not null default '',
  added_at timestamptz not null default now(),
  verified_by text not null default '',
  verified_at timestamptz,
  reply text not null default '',
  check (training_id is not null or length(trim(custom_name)) > 0)
);

-- ---------- bulletin board ----------
create table public.posts (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('announcement', 'event')),
  scope text not null default 'general',          -- 'general' or a cluster name
  title text not null check (length(trim(title)) between 1 and 120),
  body text not null default '' check (length(body) <= 3000),
  event_date date,
  event_end date,
  event_time text not null default '' check (length(event_time) <= 60),
  venue text not null default '' check (length(venue) <= 150),
  link text not null default '' check (link = '' or link ~* '^https?://\S+$'),
  pinned boolean not null default false,
  expires date,
  author_name text not null default '',
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (kind <> 'event' or event_date is not null),
  check (event_end is null or event_date is null or event_end >= event_date)
);

-- ---------- activity log ----------
create table public.audit_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  actor text not null default '',
  action text not null,
  detail text not null default ''
);

-- =====================================================================
--  helper functions (who am I?)
-- =====================================================================
create or replace function public.my_role() returns text
language sql stable security definer set search_path = public as $$
  select role from profiles where id = auth.uid() and status = 'active'
$$;
create or replace function public.my_cluster() returns text
language sql stable security definer set search_path = public as $$
  select cluster from profiles where id = auth.uid() and status = 'active'
$$;
create or replace function public.my_member_id() returns uuid
language sql stable security definer set search_path = public as $$
  select member_id from profiles where id = auth.uid() and status = 'active' and role = 'member'
$$;
create or replace function public.my_username() returns text
language sql stable security definer set search_path = public as $$
  select coalesce((select username from profiles where id = auth.uid()), 'system')
$$;
create or replace function public.is_director() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(public.my_role() = 'director', false)
$$;
-- may the signed-in person manage records of cluster c?
create or replace function public.can_manage(c text) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_director() or (public.my_role() = 'coordinator' and public.my_cluster() = c)
$$;
create or replace function public.member_cluster(mid uuid) returns text
language sql stable security definer set search_path = public as $$
  select cluster from members where id = mid
$$;

-- =====================================================================
--  triggers
-- =====================================================================
-- stamp who changed a record
create or replace function public.stamp_member() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.updated_at := now();
  new.updated_by := public.my_username();
  new.full_name := regexp_replace(trim(new.full_name), '\s+', ' ', 'g');
  -- keep only document ids that exist
  new.docs := coalesce(array(select d from unnest(new.docs) d where d in (select id from documents)), '{}');
  if new.stage_id is null then new.stage_id := (select id from stages order by sort limit 1); end if;
  return new;
end $$;
create trigger members_stamp before insert or update on public.members for each row execute function public.stamp_member();

-- activity log for the important tables
create or replace function public.log_change() returns trigger
language plpgsql security definer set search_path = public as $$
declare r jsonb; label text;
begin
  r := to_jsonb(coalesce(new, old));
  label := coalesce(r->>'full_name', r->>'title', r->>'username', r->>'name', r->>'custom_name', '');
  if TG_TABLE_NAME = 'person_trainings' then label := coalesce((select full_name from members where id = (r->>'member_id')::uuid), '') || ' — ' || coalesce(nullif(r->>'custom_name', ''), (select name from trainings where id = (r->>'training_id')::uuid), ''); end if;
  if TG_TABLE_NAME = 'requests' then label := coalesce(r->'payload'->>'fullName', '') || ' (' || (r->>'type') || ', ' || (r->>'status') || ')'; end if;
  insert into audit_log(actor, action, detail) values (public.my_username(), TG_TABLE_NAME || ' ' || lower(TG_OP), left(label, 300));
  return coalesce(new, old);
end $$;
create trigger log_members after insert or update or delete on public.members for each row execute function public.log_change();
create trigger log_posts after insert or update or delete on public.posts for each row execute function public.log_change();
create trigger log_requests after insert or update on public.requests for each row execute function public.log_change();
create trigger log_trainings after insert or update or delete on public.person_trainings for each row execute function public.log_change();
create trigger log_profiles after update or delete on public.profiles for each row execute function public.log_change();
create trigger log_invites after insert or delete on public.invites for each row execute function public.log_change();

-- cluster renamed → move posts too (posts.scope is not a foreign key because of 'general')
create or replace function public.cluster_renamed() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.name <> old.name then update posts set scope = new.name where scope = old.name; end if;
  return new;
end $$;
create trigger clusters_rename after update on public.clusters for each row execute function public.cluster_renamed();

-- posts: author + timestamps; coordinators cannot change scope to another cluster (RLS checks it too)
create or replace function public.stamp_post() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.updated_at := now();
  if TG_OP = 'INSERT' then
    new.created_by := auth.uid();
    new.author_name := coalesce((select nullif(name, '') from profiles where id = auth.uid()), public.my_username());
  else
    new.created_by := old.created_by; new.author_name := old.author_name; new.created_at := old.created_at;
  end if;
  if new.kind = 'event' then new.expires := null; else new.event_date := null; new.event_end := null; new.event_time := ''; new.venue := ''; end if;
  return new;
end $$;
create trigger posts_stamp before insert or update on public.posts for each row execute function public.stamp_post();

-- trainings: who added / verified; a Master Guide's own entry always starts "pending"
create or replace function public.stamp_training() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.cluster := public.member_cluster(new.member_id);
  if TG_OP = 'INSERT' then
    new.added_by := public.my_username(); new.added_at := now();
    if public.can_manage(new.cluster) then
      new.status := 'verified'; new.verified_by := public.my_username(); new.verified_at := now();
    else
      new.status := 'pending'; new.verified_by := ''; new.verified_at := null;
    end if;
  else
    new.added_by := old.added_by; new.added_at := old.added_at;
    if new.status <> old.status then new.verified_by := public.my_username(); new.verified_at := now(); end if;
  end if;
  return new;
end $$;
create trigger trainings_stamp before insert or update on public.person_trainings for each row execute function public.stamp_training();

-- change requests from a Master Guide: fill in the facts ourselves
create or replace function public.stamp_request() returns trigger
language plpgsql security definer set search_path = public as $$
declare m members; f text;
begin
  if TG_OP = 'INSERT' and new.type = 'change' then
    select * into m from members where id = public.my_member_id();
    if m.id is null then raise exception 'Your account is not linked to a Master Guide record yet.'; end if;
    if (select count(*) from requests where user_id = auth.uid() and status = 'pending') >= 5 then
      raise exception 'You already have 5 requests waiting. Please wait for your coordinator to review them.';
    end if;
    f := new.payload->>'field';
    if f not in ('fullName', 'district', 'church', 'trainingDate', 'investedDate', 'other') then raise exception 'Please choose what to correct.'; end if;
    new.user_id := auth.uid(); new.member_id := m.id; new.cluster := m.cluster; new.status := 'pending';
    new.decided_by := ''; new.decided_at := null; new.reply := '';
    new.payload := jsonb_build_object(
      'field', f,
      'label', case f when 'fullName' then 'Full name' when 'district' then 'District' when 'church' then 'Church'
                      when 'trainingDate' then 'Date of training' when 'investedDate' then 'Date invested' else 'Other' end,
      'value', left(coalesce(new.payload->>'value', ''), 300),
      'note', left(coalesce(new.payload->>'note', ''), 300),
      'current', case f when 'fullName' then m.full_name when 'district' then m.district when 'church' then m.church
                        when 'trainingDate' then coalesce(m.training_date::text, '') when 'investedDate' then coalesce(m.invested_date::text, '') else '' end,
      'fullName', m.full_name);
    if f in ('trainingDate', 'investedDate') and coalesce(new.payload->>'value', '') <> '' then
      perform (new.payload->>'value')::date;   -- raises on an impossible date
    end if;
  end if;
  return new;
end $$;
create trigger requests_stamp before insert on public.requests for each row execute function public.stamp_request();

-- new sign-up (Supabase Auth) → profile; invited usernames become staff right away
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare meta jsonb := coalesce(new.raw_user_meta_data, '{}'); u text; inv invites; cl text; reqd jsonb;
begin
  u := lower(coalesce(meta->>'username', split_part(new.email, '@', 1)));
  if u !~ '^[a-z0-9._-]{3,40}$' then raise exception 'Invalid username'; end if;
  select * into inv from invites where username = u;
  if inv.username is not null then
    insert into profiles(id, username, name, role, cluster, status)
      values (new.id, u, coalesce(nullif(inv.name, ''), meta->>'name', u), inv.role, inv.cluster, 'active');
    delete from invites where username = u;
  else
    cl := meta->>'cluster';
    if cl is null or not exists (select 1 from clusters where name = cl) then raise exception 'Please choose your cluster.'; end if;
    insert into profiles(id, username, name, role, cluster, status)
      values (new.id, u, left(coalesce(meta->>'name', u), 120), 'member', cl, 'pending');
    reqd := jsonb_build_object('fullName', left(coalesce(meta->>'name', ''), 120), 'district', left(coalesce(meta->>'district', ''), 80),
              'church', left(coalesce(meta->>'church', ''), 120), 'phone', left(coalesce(meta->>'phone', ''), 40),
              'email', left(coalesce(meta->>'contactEmail', ''), 120), 'note', left(coalesce(meta->>'note', ''), 300));
    insert into requests(type, user_id, cluster, payload) values ('signup', new.id, cl, reqd);
  end if;
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();

-- =====================================================================
--  actions (called from the website with supabase.rpc)
-- =====================================================================
create or replace function public.username_available(u text) returns boolean
language sql stable security definer set search_path = public as $$
  select not exists (select 1 from profiles where username = lower(u)) and not exists (select 1 from invites where username = lower(u))
$$;
-- an invited username may sign up even though it is reserved
create or replace function public.username_invited(u text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from invites where username = lower(u))
$$;

create or replace function public.touch_login() returns void
language sql security definer set search_path = public as $$
  update profiles set last_login = now() where id = auth.uid()
$$;

create or replace function public.clear_must_change() returns void
language sql security definer set search_path = public as $$
  update profiles set must_change = false where id = auth.uid()
$$;

-- approve / reject a sign-up or correction
create or replace function public.decide_request(req uuid, approve boolean, link_member uuid default null, reply_text text default '')
returns void language plpgsql security definer set search_path = public as $$
declare q requests; p profiles; mid uuid; f text; v text;
begin
  select * into q from requests where id = req for update;
  if q.id is null then raise exception 'Request not found.'; end if;
  if q.status <> 'pending' then raise exception 'This request was already %.', q.status; end if;
  if not public.can_manage(q.cluster) then raise exception 'You can only review requests in your cluster.'; end if;
  if q.type = 'signup' then
    select * into p from profiles where id = q.user_id;
    if p.id is null then raise exception 'The sign-up account no longer exists.'; end if;
    if approve then
      if link_member is not null then
        if public.member_cluster(link_member) is distinct from q.cluster then raise exception 'That record is in another cluster.'; end if;
        if exists (select 1 from profiles where member_id = link_member and status = 'active' and id <> p.id) then raise exception 'That record is already linked to another account.'; end if;
        mid := link_member;
      else
        insert into members(full_name, cluster, district, church)
          values (coalesce(nullif(q.payload->>'fullName', ''), p.name), q.cluster, coalesce(q.payload->>'district', ''), coalesce(q.payload->>'church', ''))
          returning id into mid;
      end if;
      insert into member_contacts(member_id, phone, email) values (mid, coalesce(q.payload->>'phone', ''), coalesce(q.payload->>'email', ''))
        on conflict (member_id) do update set phone = case when member_contacts.phone = '' then excluded.phone else member_contacts.phone end,
                                              email = case when member_contacts.email = '' then excluded.email else member_contacts.email end;
      update profiles set member_id = mid, status = 'active' where id = p.id;
      update requests set member_id = mid where id = q.id;
    else
      update profiles set status = 'disabled' where id = p.id;
    end if;
  elsif approve then
    f := q.payload->>'field'; v := q.payload->>'value';
    if f = 'fullName' and coalesce(v, '') <> '' then update members set full_name = v where id = q.member_id;
    elsif f = 'district' then update members set district = coalesce(v, '') where id = q.member_id;
    elsif f = 'church' then update members set church = coalesce(v, '') where id = q.member_id;
    elsif f = 'trainingDate' then update members set training_date = nullif(v, '')::date where id = q.member_id;
    elsif f = 'investedDate' then update members set invested_date = nullif(v, '')::date where id = q.member_id;
    end if;
  end if;
  update requests set status = case when approve then 'approved' else 'rejected' end, decided_by = public.my_username(),
    decided_at = now(), reply = left(coalesce(reply_text, ''), 300) where id = q.id;
end $$;

-- enable / disable an account, reset its password, change a staff role
create or replace function public.admin_update_account(uid uuid, new_status text default null, new_password text default null,
                                                       new_role text default null, new_cluster text default null, new_name text default null)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare p profiles; directors int;
begin
  select * into p from profiles where id = uid;
  if p.id is null then raise exception 'Account not found.'; end if;
  if not (public.is_director() or (p.role = 'member' and public.can_manage(p.cluster))) then raise exception 'You cannot change this account.'; end if;
  if uid = auth.uid() and (new_status is not null or new_role is not null) then raise exception 'You cannot change your own status or role.'; end if;
  if new_role is not null or new_cluster is not null then
    if not public.is_director() then raise exception 'Only the Director can change roles.'; end if;
    if p.role = 'member' or new_role not in ('director', 'coordinator') then raise exception 'Invalid role.'; end if;
  end if;
  if p.role = 'director' and (new_status in ('disabled', 'pending') or (new_role is not null and new_role <> 'director')) then
    select count(*) into directors from profiles where role = 'director' and status = 'active' and id <> uid;
    if directors = 0 then raise exception 'There must always be at least one active Director.'; end if;
  end if;
  if new_password is not null then
    if length(new_password) < 8 then raise exception 'Password must be at least 8 characters.'; end if;
    update auth.users set encrypted_password = crypt(new_password, gen_salt('bf')), updated_at = now() where id = uid;
    update profiles set must_change = true where id = uid;
  end if;
  update profiles set
    status = coalesce(new_status, status),
    role = coalesce(new_role, role),
    cluster = case when coalesce(new_role, role) = 'director' then null else coalesce(new_cluster, cluster) end,
    name = coalesce(nullif(trim(new_name), ''), name)
  where id = uid;
end $$;

create or replace function public.admin_delete_account(uid uuid) returns void
language plpgsql security definer set search_path = public as $$
declare p profiles;
begin
  if not public.is_director() then raise exception 'Only the Director can delete accounts.'; end if;
  if uid = auth.uid() then raise exception 'You cannot delete your own account.'; end if;
  select * into p from profiles where id = uid;
  if p.role = 'director' and not exists (select 1 from profiles where role = 'director' and status = 'active' and id <> uid) then
    raise exception 'There must always be at least one active Director.';
  end if;
  delete from auth.users where id = uid;
end $$;

-- verify or reject a training a Master Guide added
create or replace function public.verify_training(tid uuid, approve boolean, reply_text text default '') returns void
language plpgsql security definer set search_path = public as $$
declare t person_trainings;
begin
  select * into t from person_trainings where id = tid;
  if t.id is null then raise exception 'Training entry not found.'; end if;
  if not public.can_manage(t.cluster) then raise exception 'You can only verify trainings in your cluster.'; end if;
  update person_trainings set status = case when approve then 'verified' else 'rejected' end, reply = left(coalesce(reply_text, ''), 300) where id = tid;
end $$;

-- bulk import (coordinators: their cluster; Director: any)
create or replace function public.import_members(rows jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r jsonb; i int := 0; added int := 0; skipped jsonb := '[]'; cl text; nm text; st uuid; td date; inv date;
        first_stage uuid := (select id from stages order by sort limit 1);
        last_stage uuid := (select id from stages order by sort desc limit 1);
begin
  if public.my_role() not in ('director', 'coordinator') then raise exception 'Not allowed.'; end if;
  if jsonb_array_length(rows) > 2000 then raise exception 'Import at most 2,000 rows at a time.'; end if;
  for r in select * from jsonb_array_elements(rows) loop
    i := i + 1;
    nm := regexp_replace(trim(coalesce(r->>'fullName', '')), '\s+', ' ', 'g');
    if nm = '' then skipped := skipped || jsonb_build_object('line', i, 'reason', 'No name'); continue; end if;
    select name into cl from clusters where lower(name) = lower(trim(coalesce(r->>'cluster', '')));
    if not public.is_director() then
      if coalesce(trim(r->>'cluster'), '') <> '' and cl is distinct from public.my_cluster() then
        skipped := skipped || jsonb_build_object('line', i, 'reason', 'Not your cluster'); continue; end if;
      cl := public.my_cluster();
    end if;
    if cl is null then skipped := skipped || jsonb_build_object('line', i, 'reason', 'Unknown cluster "' || coalesce(r->>'cluster', '') || '"'); continue; end if;
    begin
      td := nullif(trim(coalesce(r->>'trainingDate', '')), '')::date;
      inv := nullif(trim(coalesce(r->>'investedDate', '')), '')::date;
    exception when others then
      skipped := skipped || jsonb_build_object('line', i, 'reason', 'Invalid date'); continue;
    end;
    if exists (select 1 from members where cluster = cl and lower(full_name) = lower(nm)) then
      skipped := skipped || jsonb_build_object('line', i, 'reason', 'Already exists'); continue; end if;
    select id into st from stages where lower(name) = lower(trim(coalesce(r->>'stage', '')));
    if st is null then st := case when inv is not null then last_stage else first_stage end; end if;
    insert into members(full_name, cluster, district, church, training_date, invested_date, stage_id)
      values (nm, cl, left(coalesce(r->>'district', ''), 80), left(coalesce(r->>'church', ''), 120), td, inv, st);
    added := added + 1;
  end loop;
  return jsonb_build_object('added', added, 'skipped', skipped);
end $$;

-- =====================================================================
--  public views (what anyone can see)
-- =====================================================================
create view public.public_members as
  select m.id, m.full_name as n, m.cluster as cl, m.district as di, m.church as ch,
         m.training_date as td, m.invested_date as inv, m.stage_id as st,
         (select count(*) from unnest(m.docs) d where d in (select id from documents))::int as dc
  from members m;
create view public.active_posts as
  select id, kind, scope, title, body, event_date, event_end, event_time, venue, link, pinned, expires, author_name, created_at, updated_at
  from posts
  where case when kind = 'event' then coalesce(event_end, event_date) >= (now() at time zone 'Asia/Manila')::date
             else expires is null or expires >= (now() at time zone 'Asia/Manila')::date end;

-- =====================================================================
--  row level security
-- =====================================================================
alter table public.settings enable row level security;
alter table public.clusters enable row level security;
alter table public.stages enable row level security;
alter table public.documents enable row level security;
alter table public.trainings enable row level security;
alter table public.members enable row level security;
alter table public.member_contacts enable row level security;
alter table public.profiles enable row level security;
alter table public.invites enable row level security;
alter table public.requests enable row level security;
alter table public.person_trainings enable row level security;
alter table public.posts enable row level security;
alter table public.audit_log enable row level security;

-- lookups: everyone reads, Director writes
create policy "read settings" on public.settings for select using (true);
create policy "director settings" on public.settings for all using (public.is_director()) with check (public.is_director());
create policy "read clusters" on public.clusters for select using (true);
create policy "director clusters" on public.clusters for all using (public.is_director()) with check (public.is_director());
create policy "read stages" on public.stages for select using (true);
create policy "director stages" on public.stages for all using (public.is_director()) with check (public.is_director());
create policy "read documents" on public.documents for select using (true);
create policy "director documents" on public.documents for all using (public.is_director()) with check (public.is_director());
create policy "read trainings" on public.trainings for select using (true);
create policy "director trainings" on public.trainings for all using (public.is_director()) with check (public.is_director());

-- members: staff of the cluster, or the Master Guide themselves (read only)
create policy "members read" on public.members for select to authenticated using (public.can_manage(cluster) or id = public.my_member_id());
create policy "members insert" on public.members for insert to authenticated with check (public.can_manage(cluster));
create policy "members update" on public.members for update to authenticated using (public.can_manage(cluster)) with check (public.can_manage(cluster));
create policy "members delete" on public.members for delete to authenticated using (public.can_manage(cluster));

create policy "contacts read" on public.member_contacts for select to authenticated using (public.can_manage(public.member_cluster(member_id)) or member_id = public.my_member_id());
create policy "contacts insert" on public.member_contacts for insert to authenticated with check (public.can_manage(public.member_cluster(member_id)) or member_id = public.my_member_id());
create policy "contacts update" on public.member_contacts for update to authenticated using (public.can_manage(public.member_cluster(member_id)) or member_id = public.my_member_id())
  with check (public.can_manage(public.member_cluster(member_id)) or member_id = public.my_member_id());

-- profiles: read yourself; staff read accounts they manage. Changes only through the actions above.
create policy "profiles read" on public.profiles for select to authenticated
  using (id = auth.uid() or public.is_director() or (role = 'member' and public.can_manage(cluster)));

create policy "invites director" on public.invites for all to authenticated using (public.is_director()) with check (public.is_director());

create policy "requests read" on public.requests for select to authenticated using (public.can_manage(cluster) or user_id = auth.uid());
create policy "requests insert" on public.requests for insert to authenticated with check (type = 'change' and public.my_member_id() is not null);

create policy "trainings read" on public.person_trainings for select to authenticated using (public.can_manage(cluster) or member_id = public.my_member_id());
create policy "trainings insert" on public.person_trainings for insert to authenticated
  with check (public.can_manage(public.member_cluster(member_id)) or member_id = public.my_member_id());
create policy "trainings update" on public.person_trainings for update to authenticated using (public.can_manage(cluster)) with check (public.can_manage(cluster));
create policy "trainings delete" on public.person_trainings for delete to authenticated
  using (public.can_manage(cluster) or (member_id = public.my_member_id() and status <> 'verified'));

create policy "posts read" on public.posts for select using (true);
create policy "posts insert" on public.posts for insert to authenticated
  with check (case when scope = 'general' then public.is_director() else public.can_manage(scope) end);
create policy "posts update" on public.posts for update to authenticated
  using (case when scope = 'general' then public.is_director() else public.can_manage(scope) end)
  with check (case when scope = 'general' then public.is_director() else public.can_manage(scope) end);
create policy "posts delete" on public.posts for delete to authenticated
  using (case when scope = 'general' then public.is_director() else public.can_manage(scope) end);

create policy "log director" on public.audit_log for select to authenticated using (public.is_director());

-- who may call what
revoke all on public.members, public.member_contacts, public.profiles, public.invites, public.requests,
              public.person_trainings, public.audit_log from anon;
grant select on public.public_members, public.active_posts to anon, authenticated;
revoke execute on function public.decide_request, public.admin_update_account, public.admin_delete_account,
                  public.verify_training, public.import_members, public.touch_login, public.clear_must_change from anon;

-- =====================================================================
--  certificate files (Supabase Storage, private bucket "certs")
--  paths:  m/<member id>/...  (Master Guide certificate)
--          t/<member id>/...  (training certificates)
-- =====================================================================
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('certs', 'certs', false, 5242880, array['application/pdf', 'image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

create or replace function public.cert_allowed(path text, writing boolean) returns boolean
language plpgsql stable security definer set search_path = public as $$
declare parts text[] := string_to_array(path, '/'); mid uuid;
begin
  if array_length(parts, 1) < 3 or parts[1] not in ('m', 't') then return false; end if;
  begin mid := parts[2]::uuid; exception when others then return false; end;
  if public.can_manage(public.member_cluster(mid)) then return true; end if;
  if mid = public.my_member_id() then return (not writing) or parts[1] = 't'; end if;
  return false;
end $$;

create policy "certs read" on storage.objects for select to authenticated using (bucket_id = 'certs' and public.cert_allowed(name, false));
create policy "certs upload" on storage.objects for insert to authenticated with check (bucket_id = 'certs' and public.cert_allowed(name, true));
create policy "certs change" on storage.objects for update to authenticated using (bucket_id = 'certs' and public.cert_allowed(name, true));
create policy "certs delete" on storage.objects for delete to authenticated using (bucket_id = 'certs' and public.cert_allowed(name, true));

-- =====================================================================
--  starting data
-- =====================================================================
insert into public.settings(key, value) values
  ('siteTitle', 'Davao Mission Master Guides'),
  ('subtitle', 'Master Guide Progress & Investiture Registry'),
  ('showDocCount', 'true');
insert into public.clusters(name, sort) values ('Cluster 1', 1), ('Cluster 2', 2), ('Cluster 3', 3);
insert into public.stages(name, sort) values ('Enrolled', 1), ('In Training', 2), ('Requirements Complete', 3), ('Approved for Investiture', 4), ('Invested', 5);
insert into public.documents(name, sort) values ('Application Form', 1), ('Pastor''s Recommendation', 2), ('Pathfinder / AY Class Record', 3),
  ('Training Attendance', 4), ('Practicum Requirements', 5), ('Medical Certificate', 6);
insert into public.trainings(name, sort) values
  ('CMT – Pathfinder Basic Staff Training (BST)', 1), ('CMT – Pathfinder Counselor', 2), ('CMT – Pathfinder Club Instructor', 3),
  ('CMT – Pathfinder Club Secretary/Treasurer', 4), ('CMT – Pathfinder Club Director', 5), ('CMT – Adventurer Basic Staff Training', 6),
  ('CMT – Adventurer Club Director', 7), ('Pathfinder Leadership Award (PLA)', 8),
  ('Advanced Pathfinder Leadership Award (APLA) / Pathfinder Instructor Award (PIA)', 9), ('Master Guide Leadership Training (workshops)', 10);
-- the first Director signs up with this username
insert into public.invites(username, name, role) values ('director', 'Master Guide Director', 'director');
