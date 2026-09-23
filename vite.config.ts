import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: { sourcemap: false },
  test: { include: ["src/**/*.test.ts", "supabase/functions/_shared/**/*.test.ts"] },
} as never);
