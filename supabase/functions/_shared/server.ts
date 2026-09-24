// Common hardening for every AI endpoint: CORS allowlist, sign-in check, user allowlist, daily quota.
import { createClient, type SupabaseClient, type User } from "@supabase/supabase-js";

const ALLOWED_ORIGINS = (Deno.env.get("ALLOWED_ORIGINS") ?? "")
  .split(",").map((s) => s.trim()).filter(Boolean);
const ALLOWED_USERS = (Deno.env.get("ALLOWED_USERS") ?? "")
  .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
export const DAILY_LIMIT = Number(Deno.env.get("AI_DAILY_LIMIT") ?? "150");

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
export const admin = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});

export function corsHeaders(origin: string | null): Record<string, string> {
  const allowed = origin && (ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes(origin));
  return {
    ...(allowed ? { "Access-Control-Allow-Origin": origin } : {}),
    "Vary": "Origin",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
    "Access-Control-Max-Age": "86400",
  };
}

export function json(body: unknown, status: number, origin: string | null): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(origin), "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

export interface Caller { user: User; db: SupabaseClient; origin: string | null }

/** Returns the signed-in caller, or a Response to send back (preflight, rejection). */
export async function authenticate(req: Request): Promise<Caller | Response> {
  const origin = req.headers.get("Origin");
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(origin) });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405, origin);
  if (ALLOWED_ORIGINS.length && (!origin || !ALLOWED_ORIGINS.includes(origin))) {
    return json({ error: "Forbidden" }, 403, origin);
  }
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) return json({ error: "Sign in first" }, 401, origin);
  // This client acts as the user, so Row Level Security applies to every query below.
  const db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });
  const { data, error } = await db.auth.getUser();
  const user = data?.user;
  if (error || !user) return json({ error: "Sign in first" }, 401, origin);
  if (ALLOWED_USERS.length) {
    const ids = [user.email, user.phone, user.phone ? `+${user.phone}` : undefined]
      .filter(Boolean).map((s) => s!.toLowerCase());
    if (!ids.some((id) => ALLOWED_USERS.includes(id))) return json({ error: "Not allowed" }, 403, origin);
  }
  return { user, db, origin };
}

/** Read a JSON body with a hard size cap. */
export async function readBody(req: Request, maxBytes: number): Promise<unknown> {
  if (Number(req.headers.get("Content-Length") ?? "0") > maxBytes) throw new Error("too large");
  const raw = await req.text();
  if (raw.length > maxBytes) throw new Error("too large");
  return JSON.parse(raw);
}

/** Take one unit of today's AI allowance. False when the daily cap is reached. */
export async function takeQuota(userId: string): Promise<boolean> {
  const { data, error } = await admin.rpc("consume_ai_quota", { p_user: userId, p_limit: DAILY_LIMIT });
  if (error) throw new Error(error.message);
  return data === true;
}

export async function takeQuotaN(userId: string, n: number): Promise<number> {
  const { data, error } = await admin.rpc("consume_ai_quota_n", { p_user: userId, p_limit: DAILY_LIMIT, p_n: n });
  if (error) throw new Error(error.message);
  return Number(data) || 0;
}

export interface Usage { input: number; output: number; searches: number; costMicro: number; gemini: boolean }
export const NO_USAGE: Usage = { input: 0, output: 0, searches: 0, costMicro: 0, gemini: false };

export async function recordUsage(userId: string, usage: Usage, refund: boolean): Promise<void> {
  const { error } = await admin.rpc("record_ai_cost", {
    p_user: userId, p_in: usage.input, p_out: usage.output, p_searches: usage.searches,
    p_cost_micro: usage.costMicro, p_gemini: usage.gemini, p_refund: refund,
  });
  if (error) console.error("usage record failed", error.message);
}

/** The user's AI choices from Settings (read as the user, so RLS applies). */
export async function getAiPrefs(db: SupabaseClient): Promise<{ provider: unknown; backup: unknown }> {
  const { data } = await db.from("settings").select("prefs").maybeSingle();
  const prefs = (data?.prefs ?? {}) as Record<string, unknown>;
  return { provider: prefs.aiProvider, backup: prefs.aiBackup };
}
