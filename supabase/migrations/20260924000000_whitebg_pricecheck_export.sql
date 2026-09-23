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
