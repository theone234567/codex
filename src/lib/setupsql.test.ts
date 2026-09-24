import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
// @ts-expect-error plain JS build script
import { buildSetupSql } from "../../scripts/build-setup-sql.mjs";

it("supabase/setup_all.sql is up to date (run: node scripts/build-setup-sql.mjs)", () => {
  expect(readFileSync("supabase/setup_all.sql", "utf8")).toBe(buildSetupSql());
});
