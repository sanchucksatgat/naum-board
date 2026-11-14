import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { getRegistry } from "../src/worker/stubs";
import type { MeResponse } from "../src/shared/api";
import { DRIVE_FILE_SCOPE } from "../src/worker/auth/google";
import {
  call, CLIENT_ID, googleTokenHandler, loginAs, mockGoogleToken, ORIGIN, resetAll, setCookieHeader, startLogin, withSession,
} from "./helpers";

const ALICE = { sub: "sub-alice", email: "alice@example.com" };
const BOB = { sub: "sub-bob", email: "bob@example.com" };

async function me(session: string | null): Promise<MeResponse> {
  const res = await call("/api/me", withSession(session));
  expect(res.status).toBe(200);
  return res.json();
}

beforeEach(resetAll);

describe("GET /auth/google", () => {
  it("Google 동의 화면으로 보내고 state 쿠키를 심는다", async () => {
    const { res, location, state } = await startLogin();
    expect(res.status).toBe(302);
    expect(location.origin + location.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    const q = location.searchParams;
    expect(q.get("client_id")).toBe(CLIENT_ID);
    expect(q.get("redirect_uri")).toBe(`${ORIGIN}/auth/google/callback`);
    expect(q.get("response_type")).toBe("code");
    expect(q.get("scope")).toBe(`openid email ${DRIVE_FILE_SCOPE}`);
    expect(q.get("access_type")).toBe("offline");
    expect(q.get("prompt")).toBe("consent");
    expect(q.get("code_challenge_method")).toBe("S256");
    expect(q.get("code_challenge")).toBeTruthy();
    expect(state.length).toBeGreaterThanOrEqual(24);
    const cookie = setCookieHeader(res, "__Host-nb_oauth")!;
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
  });

  it("클라이언트 설정이 없으면 안내 페이지", async () => {
    const res = await call("/auth/google", {}, { GOOGLE_CLIENT_ID: "" });
    expect(res.status).toBe(503);
    expect(await res.text()).toContain("설정이 필요해요");
  });

  it("OWNER_EMAIL 이 있으면 login_hint 로 넘긴다", async () => {
    const { location } = await startLogin({ OWNER_EMAIL: ALICE.email });
    expect(location.searchParams.get("login_hint")).toBe(ALICE.email);
  });
});

describe("GET /auth/google/callback", () => {
  it("최초 로그인 계정이 소유자가 되고 세션·refresh token 이 저장된다", async () => {
    const before = await me(null);
    expect(before).toEqual({ authenticated: false, setup: { googleConfigured: true, ownerClaimed: false } });

    const { res, session, tokenCalls } = await loginAs(ALICE);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/teacher");
    expect(session).toBeTruthy();
    const sc = setCookieHeader(res, "__Host-nb_session")!;
    expect(sc).toMatch(/HttpOnly/);
    expect(sc).toMatch(/Secure/);
    expect(sc).toMatch(/SameSite=Lax/);
    expect(sc).toMatch(/Max-Age=2592000/);
    // state 쿠키는 지운다
    expect(setCookieHeader(res, "__Host-nb_oauth")).toMatch(/Max-Age=0/);

    // 코드 교환 요청 내용
    const p = tokenCalls[0]!;
    expect(p.get("grant_type")).toBe("authorization_code");
    expect(p.get("code")).toBe("fake-code");
    expect(p.get("redirect_uri")).toBe(`${ORIGIN}/auth/google/callback`);
    expect(p.get("code_verifier")).toBeTruthy();

    const owner = await getRegistry(env).getOwner();
    expect(owner).toMatchObject({ sub: ALICE.sub, email: ALICE.email, hasRefreshToken: true, needsReconnect: false });

    mockGoogleToken(googleTokenHandler(ALICE));
    const after = await me(session);
    expect(after).toEqual({
      authenticated: true,
      setup: { googleConfigured: true, ownerClaimed: true },
      teacher: { email: ALICE.email },
      drive: { status: "ok" },
    });
  });

  it("소유자가 있으면 다른 계정은 거부, 원래 계정은 다시 로그인 가능", async () => {
    await loginAs(ALICE);
    const bob = await loginAs(BOB);
    expect(bob.res.status).toBe(403);
    expect(bob.session).toBeNull();
    expect(await bob.res.text()).toContain("이미 다른 교사 계정");
    expect((await getRegistry(env).getOwner())?.sub).toBe(ALICE.sub);

    const again = await loginAs({ ...ALICE, refreshToken: "rt-new" });
    expect(again.res.status).toBe(302);
    expect(again.session).toBeTruthy();
  });

  it("OWNER_EMAIL 이 있으면 다른 이메일은 소유자가 될 수 없다", async () => {
    const o = { OWNER_EMAIL: "Alice@Example.com" };
    const bob = await loginAs(BOB, o);
    expect(bob.res.status).toBe(403);
    expect(await getRegistry(env).getOwner()).toBeNull();

    const alice = await loginAs(ALICE, o);
    expect(alice.res.status).toBe(302);
    expect((await getRegistry(env).getOwner())?.sub).toBe(ALICE.sub);
  });

  it("OWNER_EMAIL 을 나중에 지정하면 그 계정으로 소유권이 넘어가고 이전 세션은 무효", async () => {
    const bob = await loginAs(BOB);
    expect((await me(bob.session)).authenticated).toBe(true);

    const o = { OWNER_EMAIL: ALICE.email };
    const alice = await loginAs(ALICE, o);
    expect(alice.res.status).toBe(302);
    expect((await getRegistry(env).getOwner())?.sub).toBe(ALICE.sub);
    expect((await me(bob.session)).authenticated).toBe(false);
  });

  it("state 가 틀리거나 없거나 변조되면 거부하고 Google 을 부르지 않는다", async () => {
    const mock = mockGoogleToken(googleTokenHandler(ALICE));
    const { state, stateCookie } = await startLogin();
    const cookie = (v: string) => ({ headers: { cookie: `__Host-nb_oauth=${encodeURIComponent(v)}` } });

    const cases: [string, RequestInit][] = [
      [`state=${state}&code=x`, {}], // 쿠키 없음
      [`state=wrong-state&code=x`, cookie(stateCookie)], // state 불일치
      [`code=x`, cookie(stateCookie)], // state 없음
      [`state=${state}&code=x`, cookie(stateCookie.slice(0, -2) + "AA")], // 서명 변조
    ];
    for (const [q, init] of cases) {
      const res = await call(`/auth/google/callback?${q}`, init);
      expect(res.status, q).toBe(400);
      expect(await res.text()).toContain("다시 시작");
    }
    expect(mock.calls).toHaveLength(0);
    expect(await getRegistry(env).getOwner()).toBeNull();
  });

  it("다른 브라우저의 state 쿠키로는 통과하지 못한다", async () => {
    const a = await startLogin();
    const b = await startLogin();
    const res = await call(`/auth/google/callback?state=${a.state}&code=x`, {
      headers: { cookie: `__Host-nb_oauth=${encodeURIComponent(b.stateCookie)}` },
    });
    expect(res.status).toBe(400);
  });

  it("사용자가 동의를 거부하면 안내", async () => {
    const { state, stateCookie } = await startLogin();
    const res = await call(`/auth/google/callback?state=${state}&error=access_denied`, {
      headers: { cookie: `__Host-nb_oauth=${encodeURIComponent(stateCookie)}` },
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("취소");
  });

  it("이메일 미인증 계정은 거부", async () => {
    const r = await loginAs({ ...ALICE, emailVerified: false });
    expect(r.res.status).toBe(400);
    expect(await getRegistry(env).getOwner()).toBeNull();
  });

  it("코드 교환이 실패하면 502", async () => {
    mockGoogleToken(() => Response.json({ error: "invalid_grant" }, { status: 400 }));
    const { state, stateCookie } = await startLogin();
    const res = await call(`/auth/google/callback?state=${state}&code=x`, {
      headers: { cookie: `__Host-nb_oauth=${encodeURIComponent(stateCookie)}` },
    });
    expect(res.status).toBe(502);
  });

  it("Drive 권한을 체크 해제하고 로그인하면 missing_scope", async () => {
    const { session } = await loginAs({ ...ALICE, scope: "openid https://www.googleapis.com/auth/userinfo.email" });
    expect((await me(session)).drive).toEqual({ status: "missing_scope" });
  });
});

describe("POST /auth/logout", () => {
  it("세션 쿠키를 지운다", async () => {
    const { session } = await loginAs(ALICE);
    const res = await call("/auth/logout", { method: "POST", headers: { origin: ORIGIN, cookie: `__Host-nb_session=${session}` } });
    expect(res.status).toBe(204);
    expect(setCookieHeader(res, "__Host-nb_session")).toMatch(/Max-Age=0/);
  });

  it("다른 사이트에서 온 요청은 거부", async () => {
    const res = await call("/auth/logout", { method: "POST", headers: { origin: "https://evil.example" } });
    expect(res.status).toBe(403);
  });
});

describe("기타 라우팅", () => {
  it("없는 API 는 JSON 404", async () => {
    const res = await call("/api/nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: "not_found" } });
  });
});
