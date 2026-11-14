import { beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { getGoogleAccessToken, invalidateGoogleAccessToken, GoogleAccessError } from "../src/worker/auth/access";
import { forgetIsolateAccessToken } from "../src/worker/auth/access";
import { getRegistry } from "../src/worker/stubs";
import { getMe, googleTokenHandler, loginAs, mockGoogleToken, resetAll } from "./helpers";

const T = { sub: "sub-t", email: "t@example.com" };

beforeEach(resetAll);

async function errorOf(p: Promise<unknown>): Promise<GoogleAccessError> {
  const e = await p.catch((x: unknown) => x);
  expect(e).toBeInstanceOf(GoogleAccessError);
  return e as GoogleAccessError;
}

describe("getGoogleAccessToken", () => {
  it("로그인 전에는 not_connected", async () => {
    expect((await errorOf(getGoogleAccessToken(env))).reason).toBe("not_connected");
  });

  it("refresh token 으로 받고 만료 전까지 캐시한다", async () => {
    await loginAs(T);
    const m = mockGoogleToken(googleTokenHandler(T, { accessToken: "at-1", expiresIn: 3600 }));
    expect(await getGoogleAccessToken(env)).toBe("at-1");
    expect(await getGoogleAccessToken(env)).toBe("at-1");
    // isolate 캐시를 비워도 Registry DO 캐시에서 받는다
    forgetIsolateAccessToken();
    expect(await getGoogleAccessToken(env)).toBe("at-1");
    expect(m.calls).toHaveLength(1);
    const p = m.calls[0]!;
    expect(p.get("grant_type")).toBe("refresh_token");
    expect(p.get("refresh_token")).toBe(`rt-${T.sub}`);
    expect(p.get("client_secret")).toBe("test-client-secret");
  });

  it("동시에 여러 번 불러도 갱신은 한 번", async () => {
    await loginAs(T);
    const m = mockGoogleToken(googleTokenHandler(T));
    const all = await Promise.all(Array.from({ length: 5 }, () => getGoogleAccessToken(env)));
    expect(new Set(all).size).toBe(1);
    expect(m.calls).toHaveLength(1);
  });

  it("만료 1분 전이 되면 다시 갱신", async () => {
    await loginAs(T);
    let n = 0;
    const m = mockGoogleToken((p) => googleTokenHandler(T, { accessToken: `at-${++n}`, expiresIn: 3600 })(p));
    const t0 = Date.now();
    expect(await getGoogleAccessToken(env)).toBe("at-1");
    vi.spyOn(Date, "now").mockReturnValue(t0 + 3600_000 - 59_000);
    expect(await getGoogleAccessToken(env)).toBe("at-2");
    expect(m.calls).toHaveLength(2);
  });

  it("invalidate 하면 새로 받는다 (Drive 401 대응)", async () => {
    await loginAs(T);
    let n = 0;
    mockGoogleToken((p) => googleTokenHandler(T, { accessToken: `at-${++n}` })(p));
    expect(await getGoogleAccessToken(env)).toBe("at-1");
    await invalidateGoogleAccessToken(env);
    expect(await getGoogleAccessToken(env)).toBe("at-2");
  });

  it("refresh token 이 취소·만료(invalid_grant)되면 reconnect_required, 다시 로그인하면 복구", async () => {
    const { session } = await loginAs(T);
    const m = mockGoogleToken(() => Response.json({ error: "invalid_grant", error_description: "Token has been expired or revoked." }, { status: 400 }));
    const e = await errorOf(getGoogleAccessToken(env));
    expect(e.reason).toBe("reconnect_required");
    expect(e.needsReconnect).toBe(true);
    expect((await getRegistry(env).getOwner())?.needsReconnect).toBe(true);

    // 이후에는 Google 을 다시 부르지 않는다
    await errorOf(getGoogleAccessToken(env));
    expect(m.calls).toHaveLength(1);

    const meRes = await getMe(session);
    expect(meRes).toMatchObject({ authenticated: true, drive: { status: "reconnect_required" } });
    m.spy.mockRestore();

    // 다시 로그인(새 refresh token) → 복구
    const again = await loginAs({ ...T, refreshToken: "rt-fresh" });
    expect((await getRegistry(env).getOwner())?.needsReconnect).toBe(false);
    const m2 = mockGoogleToken(googleTokenHandler(T, { accessToken: "at-after" }));
    expect(await getGoogleAccessToken(env)).toBe("at-after");
    expect(m2.calls[0]!.get("refresh_token")).toBe("rt-fresh");
    expect((await getMe(again.session)).drive).toEqual({ status: "ok" });
  });

  it("Google 일시 오류는 google_error 이고 연결 끊김으로 표시하지 않는다", async () => {
    const { session } = await loginAs(T);
    mockGoogleToken(() => new Response("oops", { status: 503 }));
    expect((await errorOf(getGoogleAccessToken(env))).reason).toBe("google_error");
    expect((await getRegistry(env).getOwner())?.needsReconnect).toBe(false);
    expect((await getMe(session)).drive).toEqual({ status: "unavailable" });
  });

  it("클라이언트 시크릿이 잘못되면 not_configured", async () => {
    await loginAs(T);
    mockGoogleToken(() => Response.json({ error: "invalid_client" }, { status: 401 }));
    expect((await errorOf(getGoogleAccessToken(env))).reason).toBe("not_configured");
  });
});
