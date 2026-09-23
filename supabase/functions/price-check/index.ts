// POST /functions/v1/price-check  { itemId }
// Looks up current NZ prices for one item with a single web search.
// Cheap by design: text only (no photos), cheapest model, one search, small output.
// Web pages can contain hostile text, so the model may only answer through the fixed
// report_price tool, and the numbers are clamped/validated before they are saved.
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { buildPriceQuery, cleanSources, PRICE_SYSTEM, REPORT_PRICE_TOOL, sanitizePriceReport } from "../_shared/price.ts";
import { authenticate, DAILY_LIMIT, json, readBody, recordUsage, takeQuota } from "../_shared/server.ts";

const MODEL = Deno.env.get("PRICE_MODEL") ?? "claude-haiku-4-5";
const anthropic = new Anthropic({ apiKey: Deno.env.get("ANTHROPIC_API_KEY"), timeout: 60_000, maxRetries: 1 });

const Body = z.object({ itemId: z.uuid() });

Deno.serve(async (req) => {
  const caller = await authenticate(req);
  if (caller instanceof Response) return caller;
  const { user, db, origin } = caller;

  let itemId: string;
  try {
    itemId = Body.parse(await readBody(req, 1_000)).itemId;
  } catch {
    return json({ error: "Invalid request" }, 400, origin);
  }

  const { data: item } = await db.from("items")
    .select("id,title,condition,category_path,attributes,start_price,status").eq("id", itemId).maybeSingle();
  if (!item) return json({ error: "Item not found" }, 404, origin);
  if (!item.title) return json({ error: "Write the listing first" }, 400, origin);

  try {
    if (!await takeQuota(user.id)) {
      return json({ error: `Daily AI limit (${DAILY_LIMIT}) reached. Try again tomorrow.` }, 429, origin);
    }
  } catch {
    return json({ error: "Server error" }, 500, origin);
  }

  let response: Anthropic.Message;
  try {
    response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 700,
      system: PRICE_SYSTEM,
      tools: [
        {
          type: "web_search_20250305",
          name: "web_search",
          max_uses: 1,
          user_location: { type: "approximate", country: "NZ", timezone: "Pacific/Auckland" },
        },
        REPORT_PRICE_TOOL,
      ],
      tool_choice: { type: "any" },
      messages: [{ role: "user", content: buildPriceQuery(item) }],
    });
  } catch (err) {
    await recordUsage(user.id, { input: 0, output: 0, searches: 0 }, true);
    console.error("anthropic error", err instanceof Anthropic.APIError ? err.status : "", (err as Error).message);
    const busy = err instanceof Anthropic.RateLimitError;
    return json({ error: busy ? "AI is busy - try again in a minute" : "Price check failed - try again" }, busy ? 503 : 502, origin);
  }

  await recordUsage(user.id, {
    input: response.usage.input_tokens,
    output: response.usage.output_tokens,
    searches: response.usage.server_tool_use?.web_search_requests ?? 0,
  }, false);

  const results = response.content.flatMap((b) =>
    b.type === "web_search_tool_result" && Array.isArray(b.content) ? b.content : []);
  const report = response.content.find((b) => b.type === "tool_use" && b.name === "report_price");
  if (!report || report.type !== "tool_use") return json({ error: "No price found - try again later" }, 502, origin);

  let check;
  try {
    check = sanitizePriceReport(report.input, cleanSources(results));
  } catch {
    return json({ error: "Price answer was not usable" }, 502, origin);
  }

  // Only adjust prices on drafts - never silently change something you already approved.
  const applyPrices = item.status === "draft" && check.found;
  const { error } = await db.from("items").update({
    price_check: check,
    price_checked_at: new Date().toISOString(),
    ...(applyPrices ? {
      start_price: check.start,
      buy_now_price: check.buy_now,
      price_confidence: "medium",
      price_reasoning: check.summary.slice(0, 300),
    } : {}),
  }).eq("id", itemId);
  if (error) return json({ error: "Could not save" }, 500, origin);

  return json({ ok: true, applied: applyPrices, check }, 200, origin);
});
