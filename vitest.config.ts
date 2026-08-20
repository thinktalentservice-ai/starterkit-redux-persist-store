import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    // jsdom, not node: the drivers are written against the real `Storage`
    // interface and the tab-sync path against real `StorageEvent` dispatch.
    // Faking those in node would test the fake.
    environment: "jsdom",
    include: ["src/**/*.test.ts"],
  },
});
