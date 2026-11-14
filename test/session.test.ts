import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import type { Env } from "../src/worker/env";
import { getSigningSecret, MIN_SECRET_LENGTH, resetSigningSecretCache } from "../src/worker/auth/secret";
import { requireTeacher, getTeacher, SESSION_COOKIE } from "../src/worker/auth/session";
import { signToken, verifyToken, base64UrlDecode, base64UrlEncode } from "../src/worker/auth/token";
import { HttpError } from "../src/worker/http";
import { getRegistry } from "../src/worker/stubs";
import { getMe, loginAs, resetAll } from "./helpers";

const SECRET = "x".repeat(40);

beforeEach(resetAll);
afterEach(() => vi.useRealTimers());

describe("signToken / verifyToken", () => {
  it("서명한 값을 그대로 돌려준다", async () => {
    const t = await signToken(SECRET, "student", { boardId: "b1", ref: "s:7" }, 60);
    const c = await verifyToken<{ boardId: string; ref: string }>(SECRET, "student", t);
    expect(c).toMatchObject({ boardId: "b1", ref: "s:7", p: "student" });
    expect(c!.exp - c!.iat).toBe(60);
  });

  it("용도·키가 다르면 거부", async () => {
    const t = await signToken(SECRET, "file", { id: "a" }, 60);
    expect(await verifyToken(SECRET, "session", t)).toBeNull();
    expect(await verifyToken("y".repeat(40), "file", t)).toBeNull();
  });

  it("내용이나 서명을 바꾸면 거부", async () => {
    const t = await signToken(SECRET, "session", { sub: "a" }, 60);
    const [body, sig] = t.split(".") as [string, string];
    const claims = JSON.parse(new TextDecoder().decode(base64UrlDecode(body)));
    claims.sub = "b";
    const forged = base64UrlEncode(new TextEncoder().encode(JSON.stringify(claims)));
    expect(await verifyToken(SECRET, "session", `${forged}.${sig}`)).toBeNull();
    const flipped = sig.slice(0, -1) + (sig.endsWith("A") ? "B" : "A");
    expect(await verifyToken(SECRET, "session", `${body}.${flipped}`)).toBeNull();
    for (const bad of ["", "abc", "a.b.c", ".", `${body}.`, `${body}.!!!`]) {
      expect(await verifyToken(SECRET, "session", bad)).toBeNull();
    }
  });

  it("만료되면 거부", async () => {
    const t = await signToken(SECRET, "file", { id: "a" }, 60);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 61_000);
    expect(await verifyToken(SECRET, "file", t)).toBeNull();
  });
});

describe("서명 키", () => {
  it("SESSION_SECRET 이 없으면 Registry 가 만든 키를 계속 쓴다", async () => {
    const e = { ...env, SESSION_SECRET: "" } as Env;
    const a = await getSigningSecret(e);
    resetSigningSecretCache();
    const b = await getSigningSecret(e);
    expect(a).toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(MIN_SECRET_LENGTH);
    expect(await getRegistry(env).getOrCreateSessionSecret()).toBe(a);
  });

  it("SESSION_SECRET 이 있으면 그것을 쓴다 (너무 짧으면 무시)", async () => {
    expect(await getSigningSecret({ ...env, SESSION_SECRET: SECRET } as Env)).toBe(SECRET);
    const generated = await getSigningSecret({ ...env, SESSION_SECRET: "short" } as Env);
    expect(generated).not.toBe("short");
  });
});

describe("교사 세션 쿠키", () => {
  const req = (cookie?: string) => new Request("https://nanum.example/api/x", cookie ? { headers: { cookie } } : {});

  it("정상 세션이면 requireTeacher 통과", async () => {
    const { session } = await loginAs({ sub: "s1", email: "t@example.com" });
    const t = await requireTeacher(req(`${SESSION_COOKIE}=${encodeURIComponent(session!)}`), env);
    expect(t).toMatchObject({ sub: "s1", email: "t@example.com" });
  });

  it("변조된 쿠키·없는 쿠키는 401", async () => {
    const { session } = await loginAs({ sub: "s1", email: "t@example.com" });
    const tampered = session!.slice(0, 10) + (session![10] === "a" ? "b" : "a") + session!.slice(11);
    for (const c of [undefined, `${SESSION_COOKIE}=${encodeURIComponent(tampered)}`, `${SESSION_COOKIE}=garbage`]) {
      const err = await requireTeacher(req(c), env).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).status).toBe(401);
    }
    expect((await getMe(tampered)).authenticated).toBe(false);
  });

  it("다른 서명 키로 만든 쿠키·다른 용도 토큰은 거부", async () => {
    await loginAs({ sub: "s1", email: "t@example.com" });
    const foreign = await signToken("z".repeat(40), "session", { sub: "s1", email: "t@example.com" }, 3600);
    expect(await getTeacher(req(`${SESSION_COOKIE}=${encodeURIComponent(foreign)}`), env)).toBeNull();
    const secret = await getSigningSecret(env);
    const wrongPurpose = await signToken(secret, "student", { sub: "s1", email: "t@example.com" }, 3600);
    expect(await getTeacher(req(`${SESSION_COOKIE}=${encodeURIComponent(wrongPurpose)}`), env)).toBeNull();
    const ok = await signToken(secret, "session", { sub: "s1", email: "t@example.com" }, 3600);
    expect(await getTeacher(req(`${SESSION_COOKIE}=${encodeURIComponent(ok)}`), env)).not.toBeNull();
  });

  it("30일이 지나면 만료", async () => {
    const { session } = await loginAs({ sub: "s1", email: "t@example.com" });
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 30 * 86400_000 + 1000);
    expect(await getTeacher(req(`${SESSION_COOKIE}=${encodeURIComponent(session!)}`), env)).toBeNull();
  });
});
