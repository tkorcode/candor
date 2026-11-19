import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    testTimeout: 20000,
  },
  // cloudflare:workers exists only inside Cloudflare. The tests load a stand-in (src/web/testing/cloudflare-workers.ts).
  resolve: { alias: { "cloudflare:workers": fileURLToPath(new URL("./src/web/testing/cloudflare-workers.ts", import.meta.url)) } },
});
