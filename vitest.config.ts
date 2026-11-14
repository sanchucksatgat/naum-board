import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        // 테스트 전용 가짜 값. 실제 값은 배포 시 교사가 넣는다.
        bindings: {
          GOOGLE_CLIENT_ID: "test-client-id.apps.googleusercontent.com",
          GOOGLE_CLIENT_SECRET: "test-client-secret",
        },
      },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
  },
});
