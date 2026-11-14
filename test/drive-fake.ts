/**
 * 테스트용 가짜 Google Drive (globalThis.fetch 를 가로챔) + 가짜 Board/Registry 의존성.
 * 실제 Drive 의 동작 중 우리가 쓰는 부분만 흉내 낸다.
 */
import { vi } from "vitest";
import { GOOGLE_TOKEN_URL } from "../src/worker/auth/google";
import { googleTokenHandler, type FakeAccount } from "./helpers";
import type { BoardActor, BoardDriveRpc, DriveState, DriveStatePatch, AttachmentRecord } from "../src/worker/drive";

export interface FakeFile {
  id: string;
  name: string;
  mimeType: string;
  parents: string[];
  trashed: boolean;
  appProperties: Record<string, string>;
  content: Uint8Array;
  createdTime: string;
}

export interface FakeSession {
  id: string;
  origin: string | null;
  metadata: Record<string, unknown>;
  length: number;
  contentType: string;
  fileId?: string;
}

type Override = (req: Request, url: URL) => Response | Promise<Response> | undefined | null;

const enc = new TextEncoder();
const dec = new TextDecoder();
const FOLDER = "application/vnd.google-apps.folder";

export class FakeDrive {
  files = new Map<string, FakeFile>();
  sessions = new Map<string, FakeSession>();
  calls: { method: string; url: string; auth: string | null }[] = [];
  overrides: Override[] = [];
  private n = 0;
  accessToken = "at-refreshed";

  constructor(readonly account: FakeAccount) {}

  install() {
    return vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      return this.handle(req);
    });
  }

  newId(prefix = "f"): string {
    return `${prefix}${++this.n}x`;
  }

  addFile(p: Partial<FakeFile> & { name: string }): FakeFile {
    const f: FakeFile = {
      id: p.id ?? this.newId(),
      name: p.name,
      mimeType: p.mimeType ?? "application/octet-stream",
      parents: p.parents ?? [],
      trashed: p.trashed ?? false,
      appProperties: p.appProperties ?? {},
      content: p.content ?? new Uint8Array(),
      createdTime: new Date().toISOString(),
    };
    this.files.set(f.id, f);
    return f;
  }

  /** 상위 폴더가 휴지통이면 trashed 로 보이는 Drive 동작 */
  isTrashed(f: FakeFile): boolean {
    if (f.trashed) return true;
    return f.parents.some((p) => {
      const parent = this.files.get(p);
      return parent ? this.isTrashed(parent) : false;
    });
  }

  json(f: FakeFile) {
    return {
      id: f.id,
      name: f.name,
      mimeType: f.mimeType,
      parents: f.parents,
      trashed: this.isTrashed(f),
      appProperties: f.appProperties,
      createdTime: f.createdTime,
      ...(f.mimeType === FOLDER ? {} : { size: String(f.content.byteLength) }),
      webViewLink: `https://docs.google.com/fake/${f.id}`,
    };
  }

  driveCalls(pred: (c: { method: string; url: string }) => boolean = () => true) {
    return this.calls.filter((c) => c.url.startsWith("https://www.googleapis.com/") && pred(c));
  }

  private err(status: number, reason: string, statusText = "") {
    return Response.json({ error: { code: status, message: reason, status: statusText, errors: [{ reason }] } }, { status });
  }

  async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const isToken = req.url === GOOGLE_TOKEN_URL && req.method === "POST";
    if (!isToken) this.calls.push({ method: req.method, url: req.url, auth: req.headers.get("authorization") });
    for (const o of this.overrides) {
      const r = await o(req, url);
      if (r) return r;
    }
    if (isToken) {
      const params = new URLSearchParams(dec.decode(await req.arrayBuffer()));
      return googleTokenHandler(this.account, { accessToken: this.accessToken })(params);
    }
    if (url.hostname !== "www.googleapis.com") throw new Error(`unexpected outbound fetch in test: ${req.method} ${req.url}`);

    const p = url.pathname;
    // 세션 주소 (인증 없음)
    if (p === "/upload/drive/v3/files" && url.searchParams.get("upload_id")) return this.sessionPut(req, url);

    if (req.headers.get("authorization") !== `Bearer ${this.accessToken}`) return this.err(401, "authError", "UNAUTHENTICATED");

    if (p === "/drive/v3/files" && req.method === "GET") return this.list(url);
    if (p === "/drive/v3/files" && req.method === "POST") {
      const meta = (await req.json()) as Record<string, unknown>;
      return Response.json(this.json(this.create(meta, new Uint8Array())));
    }
    const m = p.match(/^\/drive\/v3\/files\/([^/]+)$/);
    if (m) {
      const f = this.files.get(decodeURIComponent(m[1]!));
      if (!f) return this.err(404, "notFound", "NOT_FOUND");
      if (req.method === "GET" && url.searchParams.get("alt") === "media") return this.media(req, f);
      if (req.method === "GET") return Response.json(this.json(f));
      if (req.method === "PATCH") {
        Object.assign(f, (await req.json()) as object);
        return Response.json(this.json(f));
      }
    }
    if (p === "/upload/drive/v3/files" && req.method === "POST") {
      const type = url.searchParams.get("uploadType");
      if (type === "multipart") {
        const { meta, content } = parseMultipart(req.headers.get("content-type")!, new Uint8Array(await req.arrayBuffer()));
        return Response.json(this.json(this.create(meta, content)));
      }
      if (type === "resumable") {
        const id = this.newId("s");
        this.sessions.set(id, {
          id,
          origin: req.headers.get("origin"),
          metadata: (await req.json()) as Record<string, unknown>,
          length: Number(req.headers.get("x-upload-content-length")),
          contentType: req.headers.get("x-upload-content-type") ?? "",
        });
        return new Response(null, { status: 200, headers: { location: `https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=${id}` } });
      }
    }
    const um = p.match(/^\/upload\/drive\/v3\/files\/([^/]+)$/);
    if (um && req.method === "PATCH") {
      const f = this.files.get(decodeURIComponent(um[1]!));
      if (!f) return this.err(404, "notFound", "NOT_FOUND");
      f.content = new Uint8Array(await req.arrayBuffer());
      return Response.json(this.json(f));
    }
    return this.err(400, "badRequest");
  }

  create(meta: Record<string, unknown>, content: Uint8Array): FakeFile {
    return this.addFile({
      name: String(meta.name),
      mimeType: (meta.mimeType as string) ?? "application/octet-stream",
      parents: (meta.parents as string[]) ?? ["root"],
      appProperties: (meta.appProperties as Record<string, string>) ?? {},
      content,
    });
  }

  private list(url: URL): Response {
    const qs = url.searchParams.get("q") ?? "";
    const ap = qs.match(/key='(\w+)' and value='([^']*)'/);
    const parent = qs.match(/'([^']+)' in parents/);
    const mime = qs.match(/mimeType='([^']+)'/);
    const files = [...this.files.values()].filter(
      (f) =>
        (!ap || f.appProperties[ap[1]!] === ap[2]) &&
        (!parent || f.parents.includes(parent[1]!)) &&
        (!mime || f.mimeType === mime[1]) &&
        (!qs.includes("trashed=false") || !this.isTrashed(f)),
    );
    return Response.json({ files: files.map((f) => this.json(f)) });
  }

  private media(req: Request, f: FakeFile): Response {
    const range = req.headers.get("range");
    const total = f.content.byteLength;
    if (range) {
      const m = range.match(/^bytes=(\d+)-(\d*)$/);
      if (!m) return new Response(null, { status: 416 });
      const start = Number(m[1]);
      const end = m[2] ? Math.min(Number(m[2]), total - 1) : total - 1;
      if (start >= total) return new Response(null, { status: 416, headers: { "content-range": `bytes */${total}` } });
      const part = f.content.slice(start, end + 1);
      return new Response(part, {
        status: 206,
        headers: { "content-range": `bytes ${start}-${end}/${total}`, "content-length": String(part.byteLength), "content-type": f.mimeType },
      });
    }
    return new Response(f.content, { status: 200, headers: { "content-length": String(total), "content-type": f.mimeType } });
  }

  private async sessionPut(req: Request, url: URL): Promise<Response> {
    const s = this.sessions.get(url.searchParams.get("upload_id")!);
    if (!s) return this.err(404, "notFound");
    const cr = req.headers.get("content-range");
    if (cr && cr.startsWith("bytes */")) {
      if (s.fileId) return Response.json(this.json(this.files.get(s.fileId)!));
      return new Response(null, { status: 308 });
    }
    const body = new Uint8Array(await req.arrayBuffer());
    if (body.byteLength !== s.length) return this.err(400, "badContentLength");
    const f = this.create({ ...s.metadata, mimeType: s.metadata.mimeType ?? s.contentType }, body);
    s.fileId = f.id;
    return Response.json(this.json(f));
  }
}

function parseMultipart(contentType: string, body: Uint8Array): { meta: Record<string, unknown>; content: Uint8Array } {
  const boundary = contentType.match(/boundary=(.+)$/)![1]!;
  const text = dec.decode(body);
  const parts = text.split(`--${boundary}`).filter((s) => s.trim() !== "" && s.trim() !== "--");
  const bodies = parts.map((p) => {
    const i = p.indexOf("\r\n\r\n");
    return p.slice(i + 4).replace(/\r\n$/, "");
  });
  return { meta: JSON.parse(bodies[0]!) as Record<string, unknown>, content: enc.encode(bodies[1] ?? "") };
}

/** 가짜 Board DO (§10 RPC) */
export class FakeBoard implements BoardDriveRpc {
  state: DriveState;
  attachments = new Map<string, AttachmentRecord>();
  policy: { ok: true; maxBytes: number } | { ok: false; reason: string } = { ok: true, maxBytes: 25 * 1024 * 1024 };
  rows = { header: ["번호", "이름", "내용"], rows: [["1", "김하나", "=1+1"], ["2", "이둘", 'say "hi", ok']] };
  setCalls: DriveStatePatch[] = [];
  attachmentCalls = 0;

  constructor(
    readonly id: string,
    readonly code: string,
    title: string,
  ) {
    this.state = { title, code };
  }

  getUploadPolicy(_actor: BoardActor) {
    return this.policy;
  }
  getAttachment(id: string) {
    this.attachmentCalls++;
    return this.attachments.get(id) ?? null;
  }
  getDriveState() {
    return { ...this.state };
  }
  setDriveState(patch: DriveStatePatch) {
    this.setCalls.push(patch);
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) delete (this.state as unknown as Record<string, unknown>)[k];
      else (this.state as unknown as Record<string, unknown>)[k] = v;
    }
  }
  exportRows() {
    return this.rows;
  }
}
