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
