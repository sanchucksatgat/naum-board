import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        // 서버 시험: Workers 런타임(workerd) 안에서
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
          name: "worker",
          include: ["test/**/*.test.ts"],
        },
      },
      {
        // 프런트 순수 로직 시험 (상태 계산·재접속): Node 에서 가볍게
        test: {
          name: "web",
          include: ["web/**/*.test.ts"],
          environment: "node",
        },
      },
    ],
  },
});
