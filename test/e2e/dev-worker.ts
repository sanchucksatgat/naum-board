/**
 * 브라우저 시험 전용 Worker 진입점 (배포에 절대 쓰이지 않음).
 *
 * 실제 Worker(src/worker/index.ts)를 그대로 감싸고, 시험용 경로 하나만 더한다:
 *   GET /__test/login            → 시험 교사를 소유자로 등록하고 세션 쿠키를 붙여 /teacher 로 보낸다
 *   GET /__test/login?drive=ok   → (기본) Drive 권한이 있는 척 (refresh token 은 없음 → reconnect_required)
 *   GET /__test/login?drive=missing_scope → Drive 권한 없이 로그인한 상태
 *
 * 이 파일은 test/e2e/wrangler.e2e.jsonc 에서만 main 으로 쓰인다. 배포(`npm run deploy`, `wrangler deploy`)는
 * 루트 wrangler.jsonc(main = src/worker/index.ts)를 쓰므로 이 경로는 운영 Worker 에 존재할 수 없다.
 * 추가 안전장치: localhost / 127.0.0.1 에서 온 요청만 받는다.
 */
import app from "../../src/worker/index";
import type { Env } from "../../src/worker/env";
import { getRegistry } from "../../src/worker/stubs";
import { createSessionCookie, forgetOwnerCache } from "../../src/worker/auth/session";
import { DRIVE_FILE_SCOPE } from "../../src/worker/auth/google";

export { Registry, Board } from "../../src/worker/index";

const TEST_TEACHER = { sub: "e2e-test-teacher", email: "teacher@example.test" };

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/__test/login") {
      if (url.hostname !== "localhost" && url.hostname !== "127.0.0.1") return new Response("not found", { status: 404 });
      const drive = url.searchParams.get("drive") ?? "ok";
      const scope = drive === "missing_scope" ? "openid email" : `openid email ${DRIVE_FILE_SCOPE}`;
      const result = await getRegistry(env).claimOwner({ ...TEST_TEACHER, refreshToken: null, scope, ownerEmail: null });
      if (!result.ok) return new Response("owner already claimed by another account", { status: 409 });
      forgetOwnerCache();
      const headers = new Headers({ location: url.searchParams.get("to") ?? "/teacher", "cache-control": "no-store" });
      headers.append("set-cookie", await createSessionCookie(env, TEST_TEACHER));
      return new Response(null, { status: 302, headers });
    }
    return app.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
