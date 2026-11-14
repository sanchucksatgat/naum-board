/**
 * 브라우저·부하 시험 전용 Worker 진입점. 배포에 절대 쓰이지 않는다.
 *
 * 실제 Worker(src/worker/index.ts)를 그대로 감싸고 두 가지만 더한다.
 *  1) 시험용 경로 (/__test/*)
 *     GET  /__test/login?to=/teacher&drive=ok|missing_scope|none
 *            시험 교사를 소유자로 등록하고 세션 쿠키를 붙여 보낸다.
 *            ok(기본): 가짜 refresh token + drive.file 권한 → Drive 가 되는 상태
 *            missing_scope: 동의 화면에서 드라이브 체크를 끈 상태
 *            none: refresh token 없음 → reconnect_required
 *     POST /__test/drive?mode=ok|fail|api_off   가짜 Drive 상태 바꾸기
 *            fail: 모든 Drive 호출 503 (백업 실패 시험) · api_off: 403 accessNotConfigured (Drive API 안 켬)
 *     GET  /__test/drive                       가짜 Drive 파일 목록 (내보내기·백업 확인용, 글자 파일은 내용 포함)
 *  2) 가짜 Google: globalThis.fetch 를 가로채 oauth2 토큰·Drive API(폴더·resumable 업로드·파일 내려받기·백업·시트 변환)를
 *     메모리에서 흉내 낸다. 실제 Google 로는 아무 요청도 나가지 않는다.
 *
 * 이 파일은 test/e2e/wrangler.jsonc 에서만 main 으로 쓰인다. 배포(`npm run deploy`)와 `npm run build` 는
 * 루트 wrangler.jsonc(main = src/worker/index.ts)를 쓰므로 이 경로들은 운영 번들에 들어갈 수 없다
 * (`npm run build` 결과 dist/worker/index.js 에 "__test" 가 없는지 확인함). 추가로 localhost 요청만 받는다.
 */
import app from "../../src/worker/index";
import type { Env } from "../../src/worker/env";
import { getRegistry } from "../../src/worker/stubs";
import { createSessionCookie, forgetOwnerCache } from "../../src/worker/auth/session";
import { forgetIsolateAccessToken } from "../../src/worker/auth/access";
import { DRIVE_FILE_SCOPE } from "../../src/worker/auth/google";

export { Registry, Board } from "../../src/worker/index";

const TEST_TEACHER = { sub: "e2e-test-teacher", email: "teacher@example.test" };

// ───────── 가짜 Google ─────────

interface FakeFile {
  id: string;
  name: string;
  mimeType: string;
  parents: string[];
  appProperties: Record<string, string>;
  content: Uint8Array;
  trashed: boolean;
}
interface FakeSession {
  meta: { name: string; mimeType: string; parents: string[]; appProperties: Record<string, string> };
  length: number;
  fileId?: string;
}

type Mode = "ok" | "fail" | "api_off";
let mode: Mode = "ok";
const files = new Map<string, FakeFile>();
const sessions = new Map<string, FakeSession>();
let seq = 0;
const nextId = (p: string) => `${p}${Date.now().toString(36)}${(++seq).toString(36)}`;
const json = (v: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json", ...headers } });

function view(f: FakeFile) {
  return {
    id: f.id,
    name: f.name,
    mimeType: f.mimeType,
    size: String(f.content.byteLength),
    parents: f.parents,
    trashed: f.trashed,
    appProperties: f.appProperties,
    createdTime: new Date().toISOString(),
    webViewLink: f.mimeType === "application/vnd.google-apps.spreadsheet" ? `https://docs.google.com/spreadsheets/d/${f.id}/edit` : undefined,
  };
}

function matches(f: FakeFile, q: string): boolean {
  for (const m of q.matchAll(/appProperties has \{ key='([^']+)' and value='([^']*)' \}/g)) if (f.appProperties[m[1]!] !== m[2]) return false;
  for (const m of q.matchAll(/'([^']+)' in parents/g)) if (!f.parents.includes(m[1]!)) return false;
  const mt = /mimeType\s*=\s*'([^']+)'/.exec(q);
  if (mt && f.mimeType !== mt[1]) return false;
  if (/trashed\s*=\s*false/.test(q) && f.trashed) return false;
  return true;
}

function parseMultipart(body: string): { meta: Record<string, unknown>; content: string } {
  const boundary = body.slice(2, body.indexOf("\r\n"));
  const parts = body.split("--" + boundary).slice(1, -1);
  const part = (p: string) => p.slice(p.indexOf("\r\n\r\n") + 4).replace(/\r\n$/, "");
  return { meta: JSON.parse(part(parts[0]!)) as Record<string, unknown>, content: part(parts[1] ?? "") };
}

async function fakeGoogle(req: Request): Promise<Response | null> {
  const url = new URL(req.url);
  if (url.hostname === "oauth2.googleapis.com" && url.pathname === "/token") {
    return json({ access_token: "fake-access", expires_in: 3600, token_type: "Bearer", scope: `openid email ${DRIVE_FILE_SCOPE}` });
  }
  if (url.hostname !== "www.googleapis.com") return null;
  const p = url.pathname;
  const isSessionPut = p.startsWith("/upload/drive/v3/files") && req.method === "PUT";
  if (mode === "fail" && !isSessionPut) return json({ error: { code: 503, message: "fake drive: backend down" } }, 503);
  if (mode === "api_off" && !isSessionPut) {
    return json(
      { error: { code: 403, status: "PERMISSION_DENIED", message: "Google Drive API has not been used in project 0 before or it is disabled.", errors: [{ domain: "usageLimits", reason: "accessNotConfigured" }] } },
      403,
    );
  }

  // resumable 세션 PUT (바이트 또는 상태 확인)
  if (isSessionPut) {
    const sid = url.searchParams.get("upload_id") ?? "";
    const s = sessions.get(sid);
    if (!s) return json({ error: { code: 404 } }, 404);
    if (req.headers.get("content-range")?.startsWith("bytes */")) {
      if (!s.fileId) return new Response(null, { status: 308 });
      return json(view(files.get(s.fileId)!));
    }
    const bytes = new Uint8Array(await req.arrayBuffer());
    if (bytes.byteLength !== s.length) return json({ error: { code: 400, message: "length mismatch" } }, 400);
    const f: FakeFile = { id: nextId("df"), ...s.meta, content: bytes, trashed: false };
    files.set(f.id, f);
    s.fileId = f.id;
    return json(view(f));
  }
  // resumable 세션 만들기
  if (p === "/upload/drive/v3/files" && req.method === "POST" && url.searchParams.get("uploadType") === "resumable") {
    const meta = (await req.json()) as FakeSession["meta"];
    const sid = nextId("up");
    sessions.set(sid, { meta: { ...meta, appProperties: meta.appProperties ?? {}, parents: meta.parents ?? [] }, length: Number(req.headers.get("x-upload-content-length")) });
    return new Response(null, { status: 200, headers: { location: `https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=${sid}` } });
  }
  // multipart (백업 JSON, 시트 내보내기 CSV)
  if (p === "/upload/drive/v3/files" && req.method === "POST") {
    const { meta, content } = parseMultipart(await req.text());
    const f: FakeFile = {
      id: nextId("df"),
      name: String(meta.name ?? "file"),
      mimeType: String(meta.mimeType ?? "application/octet-stream"),
      parents: (meta.parents as string[]) ?? [],
      appProperties: (meta.appProperties as Record<string, string>) ?? {},
      content: new TextEncoder().encode(content),
      trashed: false,
    };
    files.set(f.id, f);
    return json(view(f));
  }
  // media 교체
  const media = /^\/upload\/drive\/v3\/files\/([^/]+)$/.exec(p);
  if (media && req.method === "PATCH") {
    const f = files.get(decodeURIComponent(media[1]!));
    if (!f) return json({ error: { code: 404 } }, 404);
    f.content = new Uint8Array(await req.arrayBuffer());
    return json(view(f));
  }
  if (p === "/drive/v3/files" && req.method === "GET") {
    const q = url.searchParams.get("q") ?? "";
    const pageSize = Number(url.searchParams.get("pageSize") ?? 100);
    return json({ files: [...files.values()].filter((f) => matches(f, q)).slice(0, pageSize).map(view) });
  }
  if (p === "/drive/v3/files" && req.method === "POST") {
    const meta = (await req.json()) as Partial<FakeFile>;
    const f: FakeFile = {
      id: nextId("fo"),
      name: meta.name ?? "folder",
      mimeType: meta.mimeType ?? "application/vnd.google-apps.folder",
      parents: meta.parents ?? [],
      appProperties: meta.appProperties ?? {},
      content: new Uint8Array(),
      trashed: false,
    };
    files.set(f.id, f);
    return json(view(f));
  }
  const one = /^\/drive\/v3\/files\/([^/]+)$/.exec(p);
  if (one) {
    const f = files.get(decodeURIComponent(one[1]!));
    if (!f) return json({ error: { code: 404, message: "not found" } }, 404);
    if (req.method === "PATCH") {
      Object.assign(f, (await req.json()) as Partial<FakeFile>);
      return json(view(f));
    }
    if (url.searchParams.get("alt") === "media") {
      const range = req.headers.get("range");
      const total = f.content.byteLength;
      const m = range && /^bytes=(\d+)-(\d*)$/.exec(range);
      if (m) {
        const start = Number(m[1]);
        const end = m[2] ? Math.min(Number(m[2]), total - 1) : total - 1;
        if (start >= total) return new Response(null, { status: 416, headers: { "content-range": `bytes */${total}` } });
        const part = f.content.slice(start, end + 1);
        return new Response(part, { status: 206, headers: { "content-type": f.mimeType, "content-length": String(part.byteLength), "content-range": `bytes ${start}-${end}/${total}` } });
      }
      return new Response(f.content, { status: 200, headers: { "content-type": f.mimeType, "content-length": String(total) } });
    }
    return json(view(f));
  }
  return json({ error: { code: 501, message: "fake drive: not implemented " + req.method + " " + p } }, 501);
}

const realFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const req = new Request(input, init);
  const host = new URL(req.url).hostname;
  if (host.endsWith("googleapis.com") || host === "accounts.google.com") {
    const r = await fakeGoogle(req);
    if (r) return r;
  }
  return realFetch(req);
}) as typeof fetch;

// ───────── 시험용 경로 ─────────

async function testRoute(request: Request, env: Env, url: URL): Promise<Response> {
  if (url.pathname === "/__test/login") {
    const drive = url.searchParams.get("drive") ?? "ok";
    const scope = drive === "missing_scope" ? "openid email" : `openid email ${DRIVE_FILE_SCOPE}`;
    const result = await getRegistry(env).claimOwner({ ...TEST_TEACHER, refreshToken: drive === "none" ? null : "fake-refresh", scope, ownerEmail: null });
    if (!result.ok) return new Response("owner already claimed by another account", { status: 409 });
    forgetOwnerCache();
    forgetIsolateAccessToken();
    const headers = new Headers({ location: url.searchParams.get("to") ?? "/teacher", "cache-control": "no-store" });
    headers.append("set-cookie", await createSessionCookie(env, TEST_TEACHER));
    return new Response(null, { status: 302, headers });
  }
  if (url.pathname === "/__test/drive") {
    if (request.method === "POST") {
      const m = url.searchParams.get("mode");
      if (m !== "ok" && m !== "fail" && m !== "api_off") return new Response("mode=ok|fail|api_off", { status: 400 });
      mode = m;
      return json({ mode });
    }
    const textual = (f: FakeFile) => !f.mimeType.startsWith("image/") && f.content.byteLength < 256 * 1024;
    return json({
      mode,
      files: [...files.values()].map((f) => ({
        id: f.id,
        name: f.name,
        mimeType: f.mimeType,
        parents: f.parents,
        size: f.content.byteLength,
        ...(textual(f) && f.content.byteLength ? { text: new TextDecoder().decode(f.content) } : {}),
      })),
    });
  }
  return new Response("not found", { status: 404 });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/__test/")) {
      if (url.hostname !== "localhost" && url.hostname !== "127.0.0.1") return new Response("not found", { status: 404 });
      return testRoute(request, env, url);
    }
    return app.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
