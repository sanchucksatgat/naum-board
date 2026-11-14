import { createExecutionContext, reset, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { vi } from "vitest";
import worker from "../src/worker/index";
import type { Env } from "../src/worker/env";
import { resetSigningSecretCache } from "../src/worker/auth/secret";
import { forgetOwnerCache } from "../src/worker/auth/session";
import { forgetIsolateAccessToken } from "../src/worker/auth/access";
import { base64UrlEncode } from "../src/worker/auth/token";
import { DRIVE_FILE_SCOPE, GOOGLE_TOKEN_URL } from "../src/worker/auth/google";

export const ORIGIN = "https://nanum.example";
export const CLIENT_ID = "test-client-id.apps.googleusercontent.com";
export const FULL_SCOPE = `openid ${DRIVE_FILE_SCOPE} https://www.googleapis.com/auth/userinfo.email`;

export async function resetAll(): Promise<void> {
  vi.restoreAllMocks();
  await reset();
  resetSigningSecretCache();
  forgetOwnerCache();
  forgetIsolateAccessToken();
}

/** Worker 를 직접 호출. envOverride 로 OWNER_EMAIL 같은 값을 바꿔 볼 수 있다. */
export async function call(path: string, init: RequestInit = {}, envOverride: Partial<Env> = {}): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(ORIGIN + path, { redirect: "manual", ...init }), { ...env, ...envOverride } as Env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

export function fakeIdToken(claims: Record<string, unknown>): string {
  const enc = (o: unknown) => base64UrlEncode(new TextEncoder().encode(JSON.stringify(o)));
  return `${enc({ alg: "RS256", typ: "JWT" })}.${enc(claims)}.c2ln`;
}

/** Set-Cookie 들에서 name=value 를 뽑는다 */
export function cookieFrom(res: Response, name: string): string | null {
  for (const c of res.headers.getSetCookie()) {
    const [pair] = c.split(";");
    const eq = pair!.indexOf("=");
    if (pair!.slice(0, eq) === name) return decodeURIComponent(pair!.slice(eq + 1));
  }
  return null;
}

export function setCookieHeader(res: Response, name: string): string | undefined {
  return res.headers.getSetCookie().find((c) => c.startsWith(name + "="));
}

type TokenHandler = (params: URLSearchParams) => Response | Promise<Response>;

/**
 * globalThis.fetch 를 가짜로 바꾼다. Google 토큰 엔드포인트만 처리하고 나머지 외부 요청은 실패시킨다.
 * (vitest-plugin 에서 메인 Worker·DO 는 테스트와 같은 isolate 에서 돌아서 이 mock 이 그대로 적용됨)
 */
export function mockGoogleToken(handler: TokenHandler) {
  const calls: URLSearchParams[] = [];
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    if (req.url === GOOGLE_TOKEN_URL && req.method === "POST") {
      const params = new URLSearchParams(new TextDecoder().decode(await req.arrayBuffer()));
      calls.push(params);
      return handler(params);
    }
    throw new Error(`unexpected outbound fetch in test: ${req.method} ${req.url}`);
  });
  return { spy, calls };
}

export interface FakeAccount {
  sub: string;
  email: string;
  refreshToken?: string;
  scope?: string;
  emailVerified?: boolean;
}

/** 토큰 엔드포인트 응답: authorization_code → 계정 정보, refresh_token → 새 access token */
export function googleTokenHandler(account: FakeAccount, opts: { accessToken?: string; expiresIn?: number } = {}): TokenHandler {
  return (p) => {
    if (p.get("grant_type") === "authorization_code") {
      return Response.json({
        access_token: "at-from-code",
        expires_in: 3599,
        refresh_token: account.refreshToken ?? `rt-${account.sub}`,
        scope: account.scope ?? FULL_SCOPE,
        token_type: "Bearer",
        id_token: fakeIdToken({
          iss: "https://accounts.google.com",
          aud: CLIENT_ID,
          sub: account.sub,
          email: account.email,
          email_verified: account.emailVerified ?? true,
          exp: Math.floor(Date.now() / 1000) + 3600,
        }),
      });
    }
    if (p.get("grant_type") === "refresh_token") {
      return Response.json({ access_token: opts.accessToken ?? "at-refreshed", expires_in: opts.expiresIn ?? 3599, token_type: "Bearer" });
    }
    return Response.json({ error: "unsupported_grant_type" }, { status: 400 });
  };
}

/** /auth/google 시작 → state 쿠키·state 값 */
export async function startLogin(envOverride: Partial<Env> = {}) {
  const res = await call("/auth/google", {}, envOverride);
  const location = new URL(res.headers.get("location")!);
  const stateCookie = cookieFrom(res, "__Host-nb_oauth")!;
  return { res, location, state: location.searchParams.get("state")!, stateCookie };
}

/** 로그인 전 과정을 가짜 Google 로 수행하고 콜백 응답을 돌려준다. */
export async function loginAs(account: FakeAccount, envOverride: Partial<Env> = {}) {
  const mock = mockGoogleToken(googleTokenHandler(account));
  const { state, stateCookie } = await startLogin(envOverride);
  const res = await call(
    `/auth/google/callback?state=${encodeURIComponent(state)}&code=fake-code`,
    { headers: { cookie: `__Host-nb_oauth=${encodeURIComponent(stateCookie)}` } },
    envOverride,
  );
  mock.spy.mockRestore();
  return { res, session: cookieFrom(res, "__Host-nb_session"), tokenCalls: mock.calls };
}

export function withSession(session: string | null): RequestInit {
  return session ? { headers: { cookie: `__Host-nb_session=${encodeURIComponent(session)}` } } : {};
}

/** GET /api/me 결과 */
export async function getMe(session: string | null): Promise<import("../src/shared/api").MeResponse> {
  return (await call("/api/me", withSession(session))).json();
}
