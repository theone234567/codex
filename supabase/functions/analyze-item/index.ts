// POST /functions/v1/analyze-item
// Turns 1-3 small photos of one item into a draft Trade Me listing.
//
// Hardening against misuse ("hijacking"):
//  * The Anthropic key lives only here, as a Supabase secret. The browser never sees it.
//  * Caller must be a signed-in user (JWT checked by the gateway AND here), optionally on an allowlist.
//  * The endpoint is not a chatbot: the prompt, model and output schema are fixed server-side.
//    The only caller-controlled inputs are JPEG images, a 300-char note and a barcode, all validated.
//  * The model can only answer in a fixed JSON schema, which is re-validated and sanitised before saving.
//  * The model has no tools and cannot act; the seller reviews every draft before listing.
//  * Per-user daily cap + a small max_tokens bound the cost of any single account.
import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";
import {
  AnalyzeRequest,
  buildUserText,
  LISTING_JSON_SCHEMA,
  sanitizeListing,
  SYSTEM_PROMPT,
} from "../_shared/listing.ts";

const MODEL = Deno.env.get("AI_MODEL") ?? "claude-opus-5";
const DAILY_LIMIT = Number(Deno.env.get("AI_DAILY_LIMIT") ?? "150");
const MAX_BODY_BYTES = 1_300_000;
const ALLOWED_ORIGINS = (Deno.env.get("ALLOWED_ORIGINS") ?? "")
  .split(",").map((s) => s.trim()).filter(Boolean);
const ALLOWED_USERS = (Deno.env.get("ALLOWED_USERS") ?? "")
  .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const anthropic = new Anthropic({
  apiKey: Deno.env.get("ANTHROPIC_API_KEY"),
  timeout: 60_000,
  maxRetries: 1,
});
const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

/** Keep tokens to a minimum: no extended thinking where the model allows it off, and the lowest effort. */
function costParams(model: string): { thinking?: Anthropic.ThinkingConfigParam; effort?: "low" } {
  if (model.startsWith("claude-haiku")) return {}; // no thinking by default; effort not supported
  const canDisableThinking = ["claude-opus-5", "claude-sonnet-5", "claude-opus-4-8", "claude-opus-4-7"]
    .includes(model);
  return canDisableThinking ? { thinking: { type: "disabled" }, effort: "low" } : { effort: "low" };
}

function corsHeaders(origin: string | null): Record<string, string> {
  const allowed = origin && (ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes(origin));
  return {
    ...(allowed ? { "Access-Control-Allow-Origin": origin } : {}),
    "Vary": "Origin",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
    "Access-Control-Max-Age": "86400",
  };
}

function json(body: unknown, status: number, origin: string | null): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(origin), "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function isJpeg(b64: string): boolean {
  try {
    const head = atob(b64.slice(0, 8));
    return head.charCodeAt(0) === 0xff && head.charCodeAt(1) === 0xd8 && head.charCodeAt(2) === 0xff;
  } catch {
    return false;
  }
}

Deno.serve(async (req) => {
  const origin = req.headers.get("Origin");
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(origin) });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405, origin);
  if (ALLOWED_ORIGINS.length && (!origin || !ALLOWED_ORIGINS.includes(origin))) {
    return json({ error: "Forbidden" }, 403, origin);
  }

  // --- who is calling? ---
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) return json({ error: "Sign in first" }, 401, origin);
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });
  const { data: userData, error: userErr } = await userClient.auth.getUser();
  const user = userData?.user;
  if (userErr || !user) return json({ error: "Sign in first" }, 401, origin);
  if (ALLOWED_USERS.length) {
    const ids = [user.email, user.phone, user.phone ? `+${user.phone}` : undefined]
      .filter(Boolean).map((s) => s!.toLowerCase());
    if (!ids.some((id) => ALLOWED_USERS.includes(id))) return json({ error: "Not allowed" }, 403, origin);
  }

  // --- validate input ---
  const len = Number(req.headers.get("Content-Length") ?? "0");
  if (len > MAX_BODY_BYTES) return json({ error: "Photos too large" }, 413, origin);
  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) return json({ error: "Photos too large" }, 413, origin);
  let input: AnalyzeRequest;
  try {
    input = AnalyzeRequest.parse(JSON.parse(raw));
  } catch {
    return json({ error: "Invalid request" }, 400, origin);
  }
  if (!input.images.every(isJpeg)) return json({ error: "Photos must be JPEG" }, 400, origin);

  // RLS guarantees this only finds the caller's own item.
  const { data: item } = await userClient.from("items").select("id").eq("id", input.itemId).maybeSingle();
  if (!item) return json({ error: "Item not found" }, 404, origin);

  // --- cost control ---
  const { data: allowed, error: quotaErr } = await admin.rpc("consume_ai_quota", {
    p_user: user.id,
    p_limit: DAILY_LIMIT,
  });
  if (quotaErr) {
    console.error("quota error", quotaErr.message);
    return json({ error: "Server error" }, 500, origin);
  }
  if (!allowed) return json({ error: `Daily AI limit (${DAILY_LIMIT} items) reached. Try again tomorrow.` }, 429, origin);

  await userClient.from("items").update({ ai_status: "processing", ai_error: null, ai_updated_at: new Date().toISOString() })
    .eq("id", input.itemId);

  const fail = async (message: string, status: number, refund: boolean) => {
    await admin.rpc("record_ai_tokens", { p_user: user.id, p_in: 0, p_out: 0, p_refund: refund });
    await userClient.from("items").update({ ai_status: "failed", ai_error: message, ai_updated_at: new Date().toISOString() })
      .eq("id", input.itemId);
    return json({ error: message }, status, origin);
  };

  // --- ask the model ---
  let response: Anthropic.Message;
  try {
    const { effort, thinking } = costParams(MODEL);
    response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1200,
      system: SYSTEM_PROMPT,
      ...(thinking ? { thinking } : {}),
      output_config: {
        ...(effort ? { effort } : {}),
        format: { type: "json_schema", schema: LISTING_JSON_SCHEMA },
      },
      messages: [{
        role: "user",
        content: [
          ...input.images.map((data) => ({
            type: "image" as const,
            source: { type: "base64" as const, media_type: "image/jpeg" as const, data },
          })),
          { type: "text" as const, text: buildUserText(input.hint, input.barcode) },
        ],
      }],
    });
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) return await fail("AI is busy - tap retry in a minute", 503, true);
    if (err instanceof Anthropic.BadRequestError) {
      console.error("anthropic 400", err.message);
      return await fail("AI could not read these photos", 422, true);
    }
    if (err instanceof Anthropic.APIError) {
      console.error("anthropic error", err.status, err.message);
      return await fail("AI service error - tap retry", 502, true);
    }
    console.error("unexpected", err);
    return await fail("AI service error - tap retry", 502, true);
  }

  await admin.rpc("record_ai_tokens", {
    p_user: user.id,
    p_in: response.usage.input_tokens,
    p_out: response.usage.output_tokens,
    p_refund: false,
  });

  if (response.stop_reason === "refusal") return await fail("AI declined this item - please fill in manually", 422, false);
  if (response.stop_reason === "max_tokens") return await fail("AI answer was cut off - tap retry", 502, false);

  const text = response.content.find((b) => b.type === "text");
  let listing;
  try {
    listing = sanitizeListing(JSON.parse(text && text.type === "text" ? text.text : ""));
  } catch {
    return await fail("AI answer was not usable - tap retry", 502, false);
  }

  const { crop, ...fields } = listing;
  const { error: saveErr } = await userClient.from("items").update({
    ...fields,
    ai_status: "done",
    ai_error: null,
    ai_updated_at: new Date().toISOString(),
  }).eq("id", input.itemId);
  if (saveErr) {
    console.error("save error", saveErr.message);
    return json({ error: "Could not save" }, 500, origin);
  }
  if (crop) {
    const { data: first } = await userClient.from("photos").select("id").eq("item_id", input.itemId)
      .order("position").limit(1).maybeSingle();
    if (first) await userClient.from("photos").update({ crop }).eq("id", first.id);
  }

  return json({
    ok: true,
    usage: { input_tokens: response.usage.input_tokens, output_tokens: response.usage.output_tokens },
  }, 200, origin);
});
