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
