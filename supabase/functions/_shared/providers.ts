// The two AIs that can write listings, behind one interface, plus cost estimates.
// Both get the same fixed prompt and answer schema; answers are sanitised by the caller.
import Anthropic from "@anthropic-ai/sdk";
import { LISTING_JSON_SCHEMA, SYSTEM_PROMPT } from "./listing.ts";

export type Provider = "claude" | "gemini";
export type FailKind = "busy" | "credit" | "unavailable" | "bad_input" | "refused" | "cut_off" | "bad_output";

export class ProviderError extends Error {
  constructor(public kind: FailKind, message: string) {
    super(message);
  }
}

export interface ListingResult {
  provider: Provider;
  raw: unknown; // parsed JSON, not yet sanitised
  inputTokens: number;
  outputTokens: number;
  costMicroUsd: number;
}

export const CLAUDE_MODEL = Deno.env.get("AI_MODEL") ?? "claude-haiku-4-5";
export const GEMINI_MODEL = Deno.env.get("GEMINI_MODEL") ?? "gemini-3.1-flash-lite";
const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const GEMINI_KEY = Deno.env.get("GEMINI_API_KEY") ?? "";
const GEMINI_PAID = Deno.env.get("GEMINI_PAID") === "true"; // free tier costs nothing

export const configured = (p: Provider) => (p === "claude" ? !!ANTHROPIC_KEY : !!GEMINI_KEY);

export const anthropic = new Anthropic({ apiKey: ANTHROPIC_KEY || "missing", timeout: 60_000, maxRetries: 1 });

// ---------- cost estimates (USD per million tokens) ----------
const CLAUDE_PRICES: Record<string, [number, number]> = {
  "claude-haiku-4-5": [1, 5],
  "claude-sonnet-5": [2, 10],
  "claude-sonnet-4-6": [3, 15],
  "claude-opus-5": [5, 25],
  "claude-opus-5-5": [4, 20],
};

export function claudeCostMicro(model: string, input: number, output: number, batch: boolean, searches = 0): number {
  const [pi, po] = CLAUDE_PRICES[model] ?? [5, 25];
  const tokens = input * pi + output * po; // micro-USD, since price is per million
  return Math.round((batch ? tokens / 2 : tokens) + searches * 10_000);
}

export function geminiCostMicro(input: number, output: number, paid = GEMINI_PAID): number {
  return paid ? Math.round(input * 0.25 + output * 1.5) : 0;
}

// ---------- which AI, in which order ----------
export function providerOrder(preferred: unknown, backup: unknown): Provider[] {
  const first: Provider = preferred === "gemini" ? "gemini" : "claude";
  const second: Provider = first === "claude" ? "gemini" : "claude";
  const order = backup === false ? [first] : [first, second];
  return order.filter(configured);
}

/** Should we try the other AI after this failure? (Not for bad input - that would fail again.) */
export const worthFallback = (kind: FailKind) => kind !== "bad_input";

// ---------- Claude ----------
/** Minimal-token request. Shared by instant mode and economy (batch) mode. */
export function claudeListingParams(images: string[], userText: string): Anthropic.MessageCreateParamsNonStreaming {
  const model = CLAUDE_MODEL;
  const lowEffort = !model.startsWith("claude-haiku"); // Haiku: no thinking by default, effort unsupported
  const canDisableThinking = ["claude-opus-5", "claude-sonnet-5", "claude-opus-4-8", "claude-opus-4-7"].includes(model);
  return {
    model,
    max_tokens: 1200,
    system: SYSTEM_PROMPT,
    ...(canDisableThinking ? { thinking: { type: "disabled" as const } } : {}),
    output_config: {
      ...(lowEffort ? { effort: "low" as const } : {}),
      format: { type: "json_schema", schema: LISTING_JSON_SCHEMA },
    },
    messages: [{
      role: "user",
      content: [
        ...images.map((data) => ({
          type: "image" as const,
          source: { type: "base64" as const, media_type: "image/jpeg" as const, data },
        })),
        { type: "text" as const, text: userText },
      ],
    }],
  };
}

export function classifyClaudeError(err: unknown): ProviderError {
  const msg = err instanceof Error ? err.message : String(err);
  if (/credit balance|billing|spend limit|usage limit/i.test(msg)) return new ProviderError("credit", "Claude credit has run out");
  if (err instanceof Anthropic.RateLimitError || err instanceof Anthropic.InternalServerError
    || err instanceof Anthropic.APIConnectionError || (err instanceof Anthropic.APIError && err.status === 529)) {
    return new ProviderError("busy", "Claude is busy");
  }
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return new ProviderError("unavailable", "Claude key is not working");
  }
  if (err instanceof Anthropic.BadRequestError) return new ProviderError("bad_input", "AI could not read these photos");
  return new ProviderError("busy", "Claude service error");
}

/** Turn a finished Claude message into a result, or throw a ProviderError. */
export function claudeMessageToResult(message: Anthropic.Message, batch: boolean): ListingResult {
  if (message.stop_reason === "refusal") throw new ProviderError("refused", "AI declined this item");
  if (message.stop_reason === "max_tokens") throw new ProviderError("cut_off", "AI answer was cut off");
  const text = message.content.find((b) => b.type === "text");
  let raw: unknown;
  try {
    raw = JSON.parse(text && text.type === "text" ? text.text : "");
  } catch {
    throw new ProviderError("bad_output", "AI answer was not usable");
  }
  return {
    provider: "claude",
    raw,
    inputTokens: message.usage.input_tokens,
    outputTokens: message.usage.output_tokens,
    costMicroUsd: claudeCostMicro(message.model ?? CLAUDE_MODEL, message.usage.input_tokens, message.usage.output_tokens, batch),
  };
}

async function writeWithClaude(images: string[], userText: string): Promise<ListingResult> {
  let message: Anthropic.Message;
  try {
    message = await anthropic.messages.create(claudeListingParams(images, userText));
  } catch (err) {
    console.error("claude error", (err as Error).message);
    throw classifyClaudeError(err);
  }
  return claudeMessageToResult(message, false);
}

// ---------- Gemini ----------
/** Gemini accepts a JSON-Schema subset; drop keywords it may not support. */
export function geminiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(geminiSchema);
  if (schema && typeof schema === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(schema)) {
      if (k === "additionalProperties") continue;
      out[k] = geminiSchema(v);
    }
    return out;
  }
  return schema;
}

export function geminiRequestBody(images: string[], userText: string, model = GEMINI_MODEL): Record<string, unknown> {
  const thinkingConfig = model.startsWith("gemini-2") ? { thinkingBudget: 0 } : { thinkingLevel: "minimal" };
  return {
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [{
      role: "user",
      parts: [
        ...images.map((data) => ({ inlineData: { mimeType: "image/jpeg", data } })),
        { text: userText },
      ],
    }],
    generationConfig: {
      responseMimeType: "application/json",
      responseJsonSchema: geminiSchema(LISTING_JSON_SCHEMA),
      maxOutputTokens: 1200,
      thinkingConfig,
    },
  };
}

interface GeminiResponse {
  candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
}

export function geminiResponseToResult(body: GeminiResponse): ListingResult {
  if (body.promptFeedback?.blockReason) throw new ProviderError("refused", "AI declined this item");
  const cand = body.candidates?.[0];
  if (!cand) throw new ProviderError("bad_output", "AI gave no answer");
  if (cand.finishReason === "MAX_TOKENS") throw new ProviderError("cut_off", "AI answer was cut off");
  if (cand.finishReason && !["STOP", "FINISH_REASON_UNSPECIFIED"].includes(cand.finishReason)) {
    throw new ProviderError("refused", "AI declined this item");
  }
  const text = (cand.content?.parts ?? []).map((p) => p.text ?? "").join("");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ProviderError("bad_output", "AI answer was not usable");
  }
  const input = body.usageMetadata?.promptTokenCount ?? 0;
  const output = (body.usageMetadata?.candidatesTokenCount ?? 0) + (body.usageMetadata?.thoughtsTokenCount ?? 0);
  return { provider: "gemini", raw, inputTokens: input, outputTokens: output, costMicroUsd: geminiCostMicro(input, output) };
}

async function writeWithGemini(images: string[], userText: string): Promise<ListingResult> {
  let res: Response;
  try {
    res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_KEY },
      body: JSON.stringify(geminiRequestBody(images, userText)),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (err) {
    console.error("gemini network error", (err as Error).message);
    throw new ProviderError("busy", "Gemini is not reachable");
  }
  if (!res.ok) {
    console.error("gemini error", res.status, (await res.text()).slice(0, 300));
    if (res.status === 429) throw new ProviderError("busy", "Gemini free limit reached for now");
    if (res.status === 401 || res.status === 403) throw new ProviderError("unavailable", "Gemini key is not working");
    if (res.status === 400) throw new ProviderError("bad_input", "AI could not read these photos");
    throw new ProviderError("busy", "Gemini service error");
  }
  return geminiResponseToResult(await res.json());
}

/** Try each AI in order until one produces a usable answer. */
export async function writeListing(
  order: Provider[], images: string[], userText: string, validate: (raw: unknown) => unknown,
): Promise<{ result: ListingResult; listing: unknown }> {
  if (!order.length) throw new ProviderError("unavailable", "No AI is set up - add an API key");
  let last: ProviderError = new ProviderError("unavailable", "No AI available");
  for (const p of order) {
    try {
      const result = p === "claude" ? await writeWithClaude(images, userText) : await writeWithGemini(images, userText);
      try {
        return { result, listing: validate(result.raw) };
      } catch {
        throw new ProviderError("bad_output", "AI answer was not usable");
      }
    } catch (err) {
      last = err instanceof ProviderError ? err : new ProviderError("busy", "AI service error");
      if (!worthFallback(last.kind)) break;
    }
  }
  throw last;
}
