import { defineConfig } from "vitest/config";

// Separate from vite.config.ts so tests don't load the React Router plugin.
export default defineConfig({
  test: { include: ["test/**/*.test.ts"], testTimeout: 20000 },
});
