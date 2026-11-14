/**
 * 보드 화면 브라우저 시험 전용 Worker 진입점 (태스크4). 배포에 절대 쓰이지 않는다.
 *
 * 실제 Worker(src/worker/index.ts)를 그대로 감싸고 두 가지만 더한다.
 *  1) GET /__test/login?to=/b/CODE  → 시험 교사를 소유자로 등록(가짜 refresh token)하고 세션 쿠키를 붙여 보낸다.
 *  2) 가짜 Google: globalThis.fetch 를 가로채 oauth2 토큰·Drive API(폴더·resumable 업로드·파일 내려받기·백업)를
 *     메모리에서 흉내 낸다. 실제 Google 로는 아무 요청도 나가지 않는다.
 *
 * 이 파일은 test/board-e2e/wrangler.jsonc 에서만 main 으로 쓰인다. 배포(`npm run deploy`)는 루트 wrangler.jsonc
 * (main = src/worker/index.ts)를 쓰므로 이 경로들은 운영 Worker 에 존재할 수 없다. 추가로 localhost 요청만 받는다.
 */
import app from "../../src/worker/index";
import type { Env } from "../../src/worker/env";
import { getRegistry } from "../../src/worker/stubs";
import { createSessionCookie, forgetOwnerCache } from "../../src/worker/auth/session";
import { DRIVE_FILE_SCOPE } from "../../src/worker/auth/google";

export { Registry, Board } from "../../src/worker/index";

const TEST_TEACHER = { sub: "board-e2e-teacher", email: "teacher@example.test" };

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

  // resumable 세션 PUT (바이트 또는 상태 확인)
  if (p.startsWith("/upload/drive/v3/files") && req.method === "PUT") {
    const sid = url.searchParams.get("upload_id") ?? "";
    const s = sessions.get(sid);
    if (!s) return json({ error: { code: 404 } }, 404);
    if (req.headers.get("content-range")?.startsWith("bytes */")) {
      if (!s.fileId) return new Response(null, { status: 308 });
      return json(view(files.get(s.fileId)!));
    }
    const bytes = new Uint8Array(await req.arrayBuffer());
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
  // multipart (백업 JSON)
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
    return json({ files: [...files.values()].filter((f) => matches(f, q)).map(view) });
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
      return new Response(f.content, { status: 200, headers: { "content-type": f.mimeType, "content-length": String(f.content.byteLength) } });
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

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/__test/login") {
      if (url.hostname !== "localhost" && url.hostname !== "127.0.0.1") return new Response("not found", { status: 404 });
      const result = await getRegistry(env).claimOwner({
        ...TEST_TEACHER,
        refreshToken: "fake-refresh",
        scope: `openid email ${DRIVE_FILE_SCOPE}`,
        ownerEmail: null,
      });
      if (!result.ok) return new Response("owner already claimed by another account", { status: 409 });
      forgetOwnerCache();
      const headers = new Headers({ location: url.searchParams.get("to") ?? "/teacher", "cache-control": "no-store" });
      headers.append("set-cookie", await createSessionCookie(env, TEST_TEACHER));
      return new Response(null, { status: 302, headers });
    }
    return app.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
