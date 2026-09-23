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
import { AnalyzeRequest, buildUserText, LISTING_JSON_SCHEMA, sanitizeListing, SYSTEM_PROMPT } from "../_shared/listing.ts";
import { authenticate, DAILY_LIMIT, json, readBody, recordUsage, takeQuota } from "../_shared/server.ts";

const MODEL = Deno.env.get("AI_MODEL") ?? "claude-opus-5";
const MAX_BODY_BYTES = 1_300_000;

const anthropic = new Anthropic({ apiKey: Deno.env.get("ANTHROPIC_API_KEY"), timeout: 60_000, maxRetries: 1 });

/** Keep tokens to a minimum: no extended thinking where the model allows it off, and the lowest effort. */
function costParams(model: string): { thinking?: Anthropic.ThinkingConfigParam; effort?: "low" } {
  if (model.startsWith("claude-haiku")) return {}; // no thinking by default; effort not supported
  const canDisableThinking = ["claude-opus-5", "claude-sonnet-5", "claude-opus-4-8", "claude-opus-4-7"]
    .includes(model);
  return canDisableThinking ? { thinking: { type: "disabled" }, effort: "low" } : { effort: "low" };
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
  const caller = await authenticate(req);
  if (caller instanceof Response) return caller;
  const { user, db, origin } = caller;

  let input: AnalyzeRequest;
  try {
    input = AnalyzeRequest.parse(await readBody(req, MAX_BODY_BYTES));
  } catch {
    return json({ error: "Invalid request" }, 400, origin);
  }
  if (!input.images.every(isJpeg)) return json({ error: "Photos must be JPEG" }, 400, origin);

  // RLS guarantees this only finds the caller's own item.
  const { data: item } = await db.from("items").select("id").eq("id", input.itemId).maybeSingle();
  if (!item) return json({ error: "Item not found" }, 404, origin);

  try {
    if (!await takeQuota(user.id)) {
      return json({ error: `Daily AI limit (${DAILY_LIMIT} items) reached. Try again tomorrow.` }, 429, origin);
    }
  } catch (e) {
    console.error("quota error", (e as Error).message);
    return json({ error: "Server error" }, 500, origin);
  }

  const stamp = () => new Date().toISOString();
  await db.from("items").update({ ai_status: "processing", ai_error: null, ai_updated_at: stamp() }).eq("id", input.itemId);

  const fail = async (message: string, status: number, refund: boolean) => {
    if (refund) await recordUsage(user.id, { input: 0, output: 0, searches: 0 }, true);
    await db.from("items").update({ ai_status: "failed", ai_error: message, ai_updated_at: stamp() }).eq("id", input.itemId);
    return json({ error: message }, status, origin);
  };

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
    console.error("anthropic error", err instanceof Anthropic.APIError ? err.status : "", (err as Error).message);
    return await fail("AI service error - tap retry", 502, true);
  }

  await recordUsage(user.id, { input: response.usage.input_tokens, output: response.usage.output_tokens, searches: 0 }, false);

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
  const { error: saveErr } = await db.from("items").update({
    ...fields, ai_status: "done", ai_error: null, ai_updated_at: stamp(),
  }).eq("id", input.itemId);
  if (saveErr) {
    console.error("save error", saveErr.message);
    return json({ error: "Could not save" }, 500, origin);
  }
  if (crop) {
    const { data: first } = await db.from("photos").select("id").eq("item_id", input.itemId)
      .order("position").limit(1).maybeSingle();
    if (first) await db.from("photos").update({ crop }).eq("id", first.id);
  }

  return json({ ok: true, usage: response.usage }, 200, origin);
});
