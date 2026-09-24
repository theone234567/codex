import { beforeAll, describe, expect, it } from "vitest";

// providers.ts reads its keys from Deno.env; provide a stand-in for Node tests.
const env: Record<string, string> = { ANTHROPIC_API_KEY: "a", GEMINI_API_KEY: "g" };
(globalThis as unknown as { Deno: unknown }).Deno = { env: { get: (k: string) => env[k] } };
let P: typeof import("./providers");
beforeAll(async () => { P = await import("./providers"); });

describe("provider choice", () => {
  it("defaults to Claude with Gemini as backup", () => {
    expect(P.providerOrder(undefined, undefined)).toEqual(["claude", "gemini"]);
    expect(P.providerOrder("gemini", true)).toEqual(["gemini", "claude"]);
    expect(P.providerOrder("gemini", false)).toEqual(["gemini"]);
    expect(P.providerOrder("something-else", false)).toEqual(["claude"]);
  });
  it("doesn't retry with the other AI for bad input", () => {
    expect(P.worthFallback("bad_input")).toBe(false);
    expect(P.worthFallback("credit")).toBe(true);
  });
});

describe("costs", () => {
  it("halves Claude cost in economy (batch) mode", () => {
    expect(P.claudeCostMicro("claude-haiku-4-5", 1000, 300, false)).toBe(2500);
    expect(P.claudeCostMicro("claude-haiku-4-5", 1000, 300, true)).toBe(1250);
    expect(P.claudeCostMicro("claude-haiku-4-5", 0, 0, false, 1)).toBe(10000);
  });
  it("counts Gemini free tier as free", () => {
    expect(P.geminiCostMicro(1000, 300, false)).toBe(0);
    expect(P.geminiCostMicro(1000, 300, true)).toBe(700);
  });
});

describe("gemini", () => {
  it("builds a minimal-thinking JSON request with the same schema", () => {
    const body = P.geminiRequestBody(["/9j/"], "List this item.", "gemini-3.1-flash-lite") as any;
    expect(body.generationConfig.thinkingConfig).toEqual({ thinkingLevel: "minimal" });
    expect(JSON.stringify(body.generationConfig.responseJsonSchema)).not.toContain("additionalProperties");
    expect(body.contents[0].parts[0].inlineData.mimeType).toBe("image/jpeg");
    expect((P.geminiRequestBody([], "x", "gemini-2.5-flash") as any).generationConfig.thinkingConfig).toEqual({ thinkingBudget: 0 });
  });
  it("reads answers and failure reasons", () => {
    const ok = P.geminiResponseToResult({
      candidates: [{ content: { parts: [{ text: '{"a":' }, { text: "1}" }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 500, candidatesTokenCount: 200 },
    });
    expect(ok.raw).toEqual({ a: 1 });
    expect(ok.costMicroUsd).toBe(0);
    expect(() => P.geminiResponseToResult({ promptFeedback: { blockReason: "SAFETY" } })).toThrow(/declined/);
    expect(() => P.geminiResponseToResult({ candidates: [{ finishReason: "MAX_TOKENS" }] })).toThrow(/cut off/);
    expect(() => P.geminiResponseToResult({ candidates: [{ content: { parts: [{ text: "nope" }] }, finishReason: "STOP" }] })).toThrow(/not usable/);
  });
});
