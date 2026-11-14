import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SetupDriveCheck } from "../src/shared/api";
import { GOOGLE_TOKEN_URL } from "../src/worker/auth/google";
import { call, googleTokenHandler, loginAs, mockGoogleToken, resetAll, startLogin, withSession } from "./helpers";

const ALICE = { sub: "sub-alice", email: "alice@example.com" };

beforeEach(resetAll);

/** 토큰 엔드포인트는 가짜 Google, Drive files 목록은 주어진 응답 */
function mockDrive(driveResponse: () => Response) {
  const token = googleTokenHandler(ALICE);
  const urls: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    if (req.url === GOOGLE_TOKEN_URL) return token(new URLSearchParams(new TextDecoder().decode(await req.arrayBuffer())));
    if (req.url.startsWith("https://www.googleapis.com/drive/v3/files")) {
      urls.push(req.url);
      return driveResponse();
    }
    throw new Error(`unexpected fetch ${req.url}`);
  });
  return urls;
}

async function driveCheck(session: string | null): Promise<Response> {
  return call("/api/setup/drive-check", withSession(session));
}

describe("GET /api/setup/drive-check", () => {
  it("로그인하지 않으면 401", async () => {
    const res = await driveCheck(null);
    expect(res.status).toBe(401);
  });

  it("드라이브에 접근되면 ok", async () => {
    const { session } = await loginAs(ALICE);
    const urls = mockDrive(() => Response.json({ files: [] }));
    const res = await driveCheck(session);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json<SetupDriveCheck>()).toEqual({ ok: true });
    expect(urls[0]).toContain("pageSize=1");
  });

  it("Drive API 를 켜지 않았으면 api_disabled", async () => {
    const { session } = await loginAs(ALICE);
    mockDrive(() =>
      Response.json(
        {
          error: {
            code: 403,
            message: "Google Drive API has not been used in project 123 before or it is disabled.",
            errors: [{ message: "…", domain: "usageLimits", reason: "accessNotConfigured" }],
            status: "PERMISSION_DENIED",
          },
        },
        { status: 403 },
      ),
    );
    const body = await (await driveCheck(session)).json<SetupDriveCheck>();
    expect(body).toMatchObject({ ok: false, code: "api_disabled" });
  });

  it("refresh token 이 만료됐으면 reconnect", async () => {
    const { session } = await loginAs(ALICE);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      if (req.url === GOOGLE_TOKEN_URL) return Response.json({ error: "invalid_grant" }, { status: 400 });
      throw new Error(`unexpected fetch ${req.url}`);
    });
    const body = await (await driveCheck(session)).json<SetupDriveCheck>();
    expect(body).toMatchObject({ ok: false, code: "reconnect" });
  });
});

describe("OAuth 콜백 오류 페이지가 설치 안내로 연결된다", () => {
  it("access_denied → /setup#help-access-denied", async () => {
    const { state, stateCookie } = await startLogin();
    const res = await call(`/auth/google/callback?state=${encodeURIComponent(state)}&error=access_denied`, {
      headers: { cookie: `__Host-nb_oauth=${encodeURIComponent(stateCookie)}` },
    });
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain("취소");
    expect(html).toContain('href="/setup#help-access-denied"');
    expect(html).toContain('href="/auth/google"');
  });

  it("클라이언트 시크릿이 틀리면(invalid_client) → /setup#help-secret", async () => {
    const mock = mockGoogleToken(() => Response.json({ error: "invalid_client" }, { status: 401 }));
    const { state, stateCookie } = await startLogin();
    const res = await call(`/auth/google/callback?state=${encodeURIComponent(state)}&code=c`, {
      headers: { cookie: `__Host-nb_oauth=${encodeURIComponent(stateCookie)}` },
    });
    mock.spy.mockRestore();
    expect(res.status).toBe(502);
    const html = await res.text();
    expect(html).toContain("Google 설정 값이 맞지 않아요");
    expect(html).toContain('href="/setup#help-secret"');
  });

  it("다른 계정이 주인이면 → /setup#help-owner", async () => {
    await loginAs(ALICE);
    const { res } = await loginAs({ sub: "sub-bob", email: "bob@example.com" });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('href="/setup#help-owner"');
  });

  it("설정 전 /auth/google → 설치 안내 점검 단계로", async () => {
    const res = await call("/auth/google", {}, { GOOGLE_CLIENT_ID: "" });
    expect(res.status).toBe(503);
    expect(await res.text()).toContain('href="/setup#check"');
  });
});
