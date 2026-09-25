import { expect, it } from "vitest";
import { explainAuthError } from "./authErrors";

it("explains common Supabase sign-in errors", () => {
  expect(explainAuthError(new Error("Invalid API key"))).toMatch(/VITE_SUPABASE_ANON_KEY/);
  expect(explainAuthError(new Error("Email address not authorized"))).toMatch(/team/);
  expect(explainAuthError(new Error("email rate limit exceeded"))).toMatch(/Wait a few minutes/);
  expect(explainAuthError(new Error("Signups not allowed for otp"))).toMatch(/isn't registered/);
  expect(explainAuthError(new TypeError("Failed to fetch"))).toMatch(/VITE_SUPABASE_URL/);
  expect(explainAuthError(new Error("something odd"))).toBe("Couldn't send a code: something odd");
});
