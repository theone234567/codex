-- klickList: complete database setup. Paste this whole file into Supabase > SQL Editor and click Run.
-- Run it ONCE on a new project. (Generated from supabase/migrations by scripts/build-setup-sql.mjs.)

-- ===== 20260923000000_init.sql =====
-- klickList schema. Every table has Row Level Security: a signed-in user can only
-- ever see or change their own rows, even if someone tampers with the web app.

create table public.batches (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  created_at timestamptz not null default now()
);

create table public.items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  batch_id uuid not null references public.batches (id) on delete cascade,
  position integer not null default 0,
  status text not null default 'draft' check (status in ('draft', 'ready', 'listed', 'sold')),
  ai_status text not null default 'pending' check (ai_status in ('pending', 'processing', 'done', 'failed', 'skipped')),
  ai_error text check (char_length(ai_error) <= 300),
  ai_updated_at timestamptz,
  hint text not null default '' check (char_length(hint) <= 300),
  barcode text not null default '' check (char_length(barcode) <= 32),
  title text not null default '' check (char_length(title) <= 80),
  subtitle text not null default '' check (char_length(subtitle) <= 50),
  description text not null default '' check (char_length(description) <= 4000),
  category_path text not null default '' check (char_length(category_path) <= 200),
  condition text not null default 'Unknown' check (condition in ('New', 'Used', 'Refurbished', 'Unknown')),
  attributes jsonb not null default '[]'::jsonb check (jsonb_typeof(attributes) = 'array'),
  start_price numeric(10, 2) check (start_price >= 0),
  buy_now_price numeric(10, 2) check (buy_now_price >= 0),
  price_confidence text check (price_confidence in ('low', 'medium', 'high')),
  price_reasoning text not null default '' check (char_length(price_reasoning) <= 300),
  shipping_size text not null default 'Small parcel',
  weight_kg numeric(8, 2),
  needs_check jsonb not null default '[]'::jsonb check (jsonb_typeof(needs_check) = 'array'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index items_batch_idx on public.items (batch_id, position);
create index items_user_idx on public.items (user_id);

create table public.photos (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  item_id uuid not null references public.items (id) on delete cascade,
  storage_path text not null unique,
  position integer not null default 0,
  width integer,
  height integer,
  rotation integer not null default 0 check (rotation in (0, 90, 180, 270)),
  crop jsonb, -- {x,y,w,h} fractions, applied when exporting
  created_at timestamptz not null default now(),
  -- a photo path must live in the owner's folder: <user_id>/...
  check (split_part(storage_path, '/', 1) = user_id::text)
);
create index photos_item_idx on public.photos (item_id, position);

-- AI usage per user per day: enforces the daily cap and shows cost.
create table public.ai_usage (
  user_id uuid not null references auth.users (id) on delete cascade,
  day date not null default (now() at time zone 'Pacific/Auckland')::date,
  calls integer not null default 0,
  input_tokens bigint not null default 0,
  output_tokens bigint not null default 0,
  primary key (user_id, day)
);

-- keep updated_at fresh
create function public.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;
create trigger items_touch before update on public.items
  for each row execute function public.touch_updated_at();

-- Items and photos must belong to a batch/item owned by the same user.
create function public.check_item_owner() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.batches b where b.id = new.batch_id and b.user_id = new.user_id) then
    raise exception 'batch not found';
  end if;
  return new;
end $$;
create trigger items_owner before insert or update of batch_id, user_id on public.items
  for each row execute function public.check_item_owner();

create function public.check_photo_owner() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.items i where i.id = new.item_id and i.user_id = new.user_id) then
    raise exception 'item not found';
  end if;
  return new;
end $$;
create trigger photos_owner before insert or update of item_id, user_id on public.photos
  for each row execute function public.check_photo_owner();

-- ---------- Row Level Security ----------
alter table public.batches enable row level security;
alter table public.items enable row level security;
alter table public.photos enable row level security;
alter table public.ai_usage enable row level security;

create policy "own batches" on public.batches for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "own items" on public.items for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "own photos" on public.photos for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
-- users may read their usage, but only the server (service role) may change it
create policy "read own usage" on public.ai_usage for select to authenticated
  using (user_id = (select auth.uid()));

-- The signed-in user may not set AI bookkeeping to arbitrary values via the API
revoke all on public.ai_usage from anon, authenticated;
grant select on public.ai_usage to authenticated;
revoke all on public.batches, public.items, public.photos from anon;

-- ---------- AI quota (called only by the Edge Function with the service role) ----------
create function public.consume_ai_quota(p_user uuid, p_limit integer) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v_calls integer;
begin
  insert into public.ai_usage as u (user_id, calls) values (p_user, 1)
  on conflict (user_id, day) do update set calls = u.calls + 1
  returning calls into v_calls;
  if v_calls > p_limit then
    update public.ai_usage set calls = calls - 1
      where user_id = p_user and day = (now() at time zone 'Pacific/Auckland')::date;
    return false;
  end if;
  return true;
end $$;

create function public.record_ai_tokens(p_user uuid, p_in bigint, p_out bigint, p_refund boolean)
returns void
language plpgsql security definer set search_path = '' as $$
begin
  update public.ai_usage
     set input_tokens = input_tokens + greatest(p_in, 0),
         output_tokens = output_tokens + greatest(p_out, 0),
         calls = case when p_refund then greatest(calls - 1, 0) else calls end
   where user_id = p_user and day = (now() at time zone 'Pacific/Auckland')::date;
end $$;

revoke execute on function public.consume_ai_quota(uuid, integer) from public, anon, authenticated;
revoke execute on function public.record_ai_tokens(uuid, bigint, bigint, boolean) from public, anon, authenticated;
grant execute on function public.consume_ai_quota(uuid, integer) to service_role;
grant execute on function public.record_ai_tokens(uuid, bigint, bigint, boolean) to service_role;
revoke execute on function public.check_item_owner() from public, anon, authenticated;
revoke execute on function public.check_photo_owner() from public, anon, authenticated;

-- ---------- Private photo storage ----------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('photos', 'photos', false, 6 * 1024 * 1024, array['image/jpeg']);

-- Files are stored as <user_id>/<item_id>/<photo_id>.jpg ; users only touch their own folder.
create policy "photos read own" on storage.objects for select to authenticated
  using (bucket_id = 'photos' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "photos insert own" on storage.objects for insert to authenticated
  with check (bucket_id = 'photos' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "photos delete own" on storage.objects for delete to authenticated
  using (bucket_id = 'photos' and (storage.foldername(name))[1] = (select auth.uid())::text);

-- ===== 20260924000000_whitebg_pricecheck_export.sql =====
-- White backgrounds, online price checks, Trade Me export settings.

alter table public.photos
  add column bg_status text not null default 'none' check (bg_status in ('none', 'done', 'failed')),
  add column use_white boolean not null default true;

alter table public.items
  add column tm_category text not null default '' check (char_length(tm_category) <= 60),
  add column price_check jsonb check (price_check is null or jsonb_typeof(price_check) = 'object'),
  add column price_checked_at timestamptz,
  add column exported_at timestamptz;

alter table public.ai_usage
  add column web_searches integer not null default 0;

-- One row of settings per user (Trade Me CSV template, learned category codes, preferences).
create table public.settings (
  user_id uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  tm_template jsonb check (tm_template is null or jsonb_typeof(tm_template) = 'object'),
  category_map jsonb not null default '{}'::jsonb check (jsonb_typeof(category_map) = 'object'),
  prefs jsonb not null default '{}'::jsonb check (jsonb_typeof(prefs) = 'object'),
  updated_at timestamptz not null default now(),
  check (pg_column_size(tm_template) < 200000 and pg_column_size(category_map) < 200000)
);
alter table public.settings enable row level security;
create policy "own settings" on public.settings for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
revoke all on public.settings from anon;

-- Record web searches alongside tokens (server only).
create or replace function public.record_ai_usage(p_user uuid, p_in bigint, p_out bigint, p_searches integer, p_refund boolean)
returns void
language plpgsql security definer set search_path = '' as $$
begin
  update public.ai_usage
     set input_tokens = input_tokens + greatest(p_in, 0),
         output_tokens = output_tokens + greatest(p_out, 0),
         web_searches = web_searches + greatest(p_searches, 0),
         calls = case when p_refund then greatest(calls - 1, 0) else calls end
   where user_id = p_user and day = (now() at time zone 'Pacific/Auckland')::date;
end $$;
revoke execute on function public.record_ai_usage(uuid, bigint, bigint, integer, boolean) from public, anon, authenticated;
grant execute on function public.record_ai_usage(uuid, bigint, bigint, integer, boolean) to service_role;

-- Photos rendered for Trade Me import links live under <user_id>/export/... ; allow overwriting them.
create policy "photos update own" on storage.objects for update to authenticated
  using (bucket_id = 'photos' and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (bucket_id = 'photos' and (storage.foldername(name))[1] = (select auth.uid())::text);

-- ===== 20260925000000_economy_gemini.sql =====
-- Economy mode (Anthropic Batch API, 50% off), Gemini as an alternative/backup AI, cost tracking.

alter table public.items drop constraint items_ai_status_check;
alter table public.items add constraint items_ai_status_check
  check (ai_status in ('pending', 'queued', 'batched', 'processing', 'done', 'failed', 'skipped'));
alter table public.items add column ai_provider text check (ai_provider in ('claude', 'gemini'));

alter table public.ai_usage
  add column est_cost_micro_usd bigint not null default 0,
  add column gemini_calls integer not null default 0;

-- Economy batches submitted to Anthropic. Only the server writes these.
create table public.ai_batches (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  anthropic_batch_id text not null unique check (char_length(anthropic_batch_id) <= 100),
  item_ids uuid[] not null,
  status text not null default 'in_progress' check (status in ('in_progress', 'done', 'failed')),
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create index ai_batches_user_idx on public.ai_batches (user_id, status);
alter table public.ai_batches enable row level security;
create policy "read own batches" on public.ai_batches for select to authenticated
  using (user_id = (select auth.uid()));
revoke all on public.ai_batches from anon, authenticated;
grant select on public.ai_batches to authenticated;

create or replace function public.record_ai_cost(
  p_user uuid, p_in bigint, p_out bigint, p_searches integer, p_cost_micro bigint, p_gemini boolean, p_refund boolean)
returns void
language plpgsql security definer set search_path = '' as $$
begin
  update public.ai_usage
     set input_tokens = input_tokens + greatest(p_in, 0),
         output_tokens = output_tokens + greatest(p_out, 0),
         web_searches = web_searches + greatest(p_searches, 0),
         est_cost_micro_usd = est_cost_micro_usd + greatest(p_cost_micro, 0),
         gemini_calls = gemini_calls + case when p_gemini then 1 else 0 end,
         calls = case when p_refund then greatest(calls - 1, 0) else calls end
   where user_id = p_user and day = (now() at time zone 'Pacific/Auckland')::date;
end $$;
revoke execute on function public.record_ai_cost(uuid, bigint, bigint, integer, bigint, boolean, boolean) from public, anon, authenticated;
grant execute on function public.record_ai_cost(uuid, bigint, bigint, integer, bigint, boolean, boolean) to service_role;

-- Take several units of quota at once (economy batches). Returns how many were granted.
create or replace function public.consume_ai_quota_n(p_user uuid, p_limit integer, p_n integer)
returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_calls integer;
  v_grant integer;
begin
  insert into public.ai_usage as u (user_id, calls) values (p_user, 0)
  on conflict (user_id, day) do nothing;
  select calls into v_calls from public.ai_usage
   where user_id = p_user and day = (now() at time zone 'Pacific/Auckland')::date for update;
  v_grant := least(greatest(p_n, 0), greatest(p_limit - v_calls, 0));
  update public.ai_usage set calls = calls + v_grant
   where user_id = p_user and day = (now() at time zone 'Pacific/Auckland')::date;
  return v_grant;
end $$;
revoke execute on function public.consume_ai_quota_n(uuid, integer, integer) from public, anon, authenticated;
grant execute on function public.consume_ai_quota_n(uuid, integer, integer) to service_role;

-- ===== 20260926000000_explicit_grants.sql =====
-- Explicit privileges, so klickList works when the project has "Automatically expose new tables"
-- turned OFF (Supabase's recommended setting). Row Level Security still limits every row to its owner.
grant usage on schema public to authenticated, service_role;

grant select, insert, update, delete on public.batches, public.items, public.photos, public.settings to authenticated;
grant select on public.ai_usage, public.ai_batches to authenticated;

-- The server (Edge Functions) uses service_role; it bypasses RLS but still needs table privileges.
grant select, insert, update, delete on public.batches, public.items, public.photos, public.settings,
  public.ai_usage, public.ai_batches to service_role;

-- Nothing for signed-out visitors.
revoke all on public.batches, public.items, public.photos, public.settings, public.ai_usage, public.ai_batches from anon;
