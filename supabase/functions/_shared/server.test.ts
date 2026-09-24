import { beforeAll, describe, expect, it } from "vitest";

(globalThis as unknown as { Deno: unknown }).Deno = { env: { get: (k: string) => ({ SUPABASE_URL: "http://x" } as Record<string, string>)[k] } };
let S: typeof import("./server");
beforeAll(async () => { S = await import("./server"); });

describe("pickKey", () => {
  it("prefers the legacy key, then the newer JSON map, then a plain string", () => {
    expect(S.pickKey("legacy", '{"default":"sb_x"}')).toBe("legacy");
    expect(S.pickKey(undefined, '{"default":"sb_publishable_abc"}')).toBe("sb_publishable_abc");
    expect(S.pickKey(undefined, '{"other":"sb_secret_1"}')).toBe("sb_secret_1");
    expect(S.pickKey(undefined, "sb_publishable_plain")).toBe("sb_publishable_plain");
    expect(S.pickKey(undefined, undefined)).toBe("");
  });
});
