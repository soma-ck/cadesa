import { defineConfig } from "vitest/config";

export default defineConfig({
  // Browser tests start Chromium and load pages at several widths: slow on shared CI machines.
  test: { include: ["test/**/*.test.ts"], exclude: ["**/node_modules/**", ".claude/**"], testTimeout: 60_000, hookTimeout: 60_000 },
});
