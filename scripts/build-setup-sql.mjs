// Combines all migrations into supabase/setup_all.sql, for pasting into Supabase's SQL Editor in one go.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";

export function buildSetupSql() {
  const files = readdirSync("supabase/migrations").filter((f) => f.endsWith(".sql")).sort();
  return "-- klickList: complete database setup. Paste this whole file into Supabase > SQL Editor and click Run.\n"
    + "-- Run it ONCE on a new project. (Generated from supabase/migrations by scripts/build-setup-sql.mjs.)\n\n"
    + files.map((f) => `-- ===== ${f} =====\n${readFileSync(`supabase/migrations/${f}`, "utf8").trim()}\n`).join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  writeFileSync("supabase/setup_all.sql", buildSetupSql());
  console.log("wrote supabase/setup_all.sql");
}
