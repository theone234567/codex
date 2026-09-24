import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const cfg = JSON.parse(readFileSync("klicklist.config.json", "utf8"));
const host = `${cfg.supabaseProjectRef}.supabase.co`;

it("the website may only contact KlickList's own Supabase project", () => {
  const headers = readFileSync("public/_headers", "utf8");
  expect(headers).toContain(`connect-src 'self' https://${host} wss://${host};`);
  expect(headers).not.toContain("*.supabase.co");
});

it("the deploy workflow checks the project ref and name before doing anything", () => {
  const wf = readFileSync(".github/workflows/deploy-supabase.yml", "utf8");
  const guard = wf.indexOf("Guardrail: only KlickList's own Supabase project");
  const nameGuard = wf.indexOf("Guardrail: confirm the project name");
  const firstChange = wf.indexOf("supabase secrets set");
  expect(guard).toBeGreaterThan(0);
  expect(nameGuard).toBeGreaterThan(guard);
  expect(firstChange).toBeGreaterThan(nameGuard);
  expect(wf).toContain("if: github.ref == 'refs/heads/main'");
});
