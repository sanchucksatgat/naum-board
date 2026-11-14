import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { call, loginAs, resetAll, withSession, ORIGIN } from "./helpers";
import { FakeBoard, FakeDrive } from "./drive-fake";
import { ensureBoardFolders, renameBoardFolder, setDriveDeps, writeBoardBackup, DriveError } from "../src/worker/drive";
import { resetDriveDeps } from "../src/worker/drive/deps";
import { resetDriveFolderCache } from "../src/worker/drive/folders";
import { driveRetryConfig } from "../src/worker/drive/client";
import { toCsv } from "../src/worker/drive/export";
import { getRegistry } from "../src/worker/stubs";
import { getSigningSecret, invalidateGoogleAccessToken, signToken, verifyToken } from "../src/worker/auth";
import type { CompleteUploadResponse, CreateUploadResponse, UploadedFile } from "../src/shared/files";

const T = { sub: "sub-t", email: "t@example.com" };
const FOLDER = "application/vnd.google-apps.folder";

let drive: FakeDrive;
let board: FakeBoard;
let session: string | null;

beforeEach(async () => {
  await resetAll();
  resetDriveDeps();
  resetDriveFolderCache();
  driveRetryConfig.baseMs = 1;
  ({ session } = await loginAs(T));
  drive = new FakeDrive(T);
  drive.install();
  board = new FakeBoard("b1", "ABC234", "3학년 과학");
  setDriveDeps({
    resolveBoardByCode: async (_env, code) => (code === board.code ? { id: board.id, code: board.code, title: board.state.title, archived: false } : null),
    board: (_env, id) => {
      if (id !== board.id) throw new Error("unknown board " + id);
      return board;
    },
    authenticateBoardActor: async (req, _env, code) => {
      const a = req.headers.get("x-test-actor");
      if (!a || code !== board.code) return null;
      const [role, ref] = a.split(":") as ["teacher" | "student", string];
      return { role, ref, name: ref, boardId: board.id, code: board.code };
    },
  });
});

afterEach(() => {
  resetDriveDeps();
});

const folders = () => [...drive.files.values()].filter((f) => f.mimeType === FOLDER);

describe("ensureBoardFolders", () => {
  it("처음에는 나눔보드/{제목} ({코드})/첨부 를 만들고 id 를 저장한다", async () => {
    const r = await ensureBoardFolders(env, board.id);
    const root = drive.files.get((await getRegistry(env).getDriveRootId())!)!;
    expect(root.name).toBe("나눔보드");
    const bf = drive.files.get(r.folderId)!;
    expect(bf.name).toBe("3학년 과학 (ABC234)");
    expect(bf.parents).toEqual([root.id]);
    const af = drive.files.get(r.attachFolderId)!;
    expect(af.name).toBe("첨부");
    expect(af.parents).toEqual([bf.id]);
    expect(board.state).toMatchObject({ folderId: r.folderId, attachFolderId: r.attachFolderId });

    // 두 번째는 isolate 캐시로 Drive 를 부르지 않는다
    const before = drive.driveCalls().length;
    expect(await ensureBoardFolders(env, board.id)).toEqual(r);
    expect(drive.driveCalls().length).toBe(before);
    expect(folders()).toHaveLength(3);
  });

  it("동시에 불러도 폴더는 한 벌만", async () => {
    await Promise.all([ensureBoardFolders(env, board.id), ensureBoardFolders(env, board.id), ensureBoardFolders(env, board.id)]);
    expect(folders()).toHaveLength(3);
  });

  it("교사가 보드 폴더를 휴지통에 넣으면 다시 만든다 (루트는 그대로)", async () => {
    const r1 = await ensureBoardFolders(env, board.id);
    board.state.backupFileId = "old-backup";
    drive.files.get(r1.folderId)!.trashed = true;
    resetDriveFolderCache();
    const r2 = await ensureBoardFolders(env, board.id);
    expect(r2.folderId).not.toBe(r1.folderId);
    expect(r2.attachFolderId).not.toBe(r1.attachFolderId);
    expect(drive.files.get(r2.folderId)!.trashed).toBe(false);
    expect(board.state.backupFileId).toBeUndefined();
    expect(folders().filter((f) => f.name === "나눔보드")).toHaveLength(1);
  });

  it("루트 폴더를 완전히 지우면 루트부터 다시 만들고 Registry 에 저장", async () => {
    const r1 = await ensureBoardFolders(env, board.id);
    const oldRoot = (await getRegistry(env).getDriveRootId())!;
    for (const id of [oldRoot, r1.folderId, r1.attachFolderId]) drive.files.delete(id);
    resetDriveFolderCache();
    const r2 = await ensureBoardFolders(env, board.id);
    const newRoot = await getRegistry(env).getDriveRootId();
    expect(newRoot).not.toBe(oldRoot);
    expect(drive.files.get(r2.folderId)!.parents).toEqual([newRoot]);
  });

  it("첨부 폴더만 지워졌으면 첨부 폴더만 새로", async () => {
    const r1 = await ensureBoardFolders(env, board.id);
    drive.files.delete(r1.attachFolderId);
    resetDriveFolderCache();
    const r2 = await ensureBoardFolders(env, board.id);
    expect(r2.folderId).toBe(r1.folderId);
    expect(r2.attachFolderId).not.toBe(r1.attachFolderId);
  });

  it("저장된 id 를 잃어도 appProperties 표시로 기존 폴더를 다시 찾는다", async () => {
    const r1 = await ensureBoardFolders(env, board.id);
    board.state = { title: board.state.title, code: board.code };
    resetDriveFolderCache();
    const r2 = await ensureBoardFolders(env, board.id);
    expect(r2).toEqual(r1);
    expect(folders()).toHaveLength(3);
  });
});

describe("Drive 클라이언트", () => {
  it("401 이면 토큰을 무효화하고 한 번 다시 시도한다", async () => {
    await invalidateGoogleAccessToken(env);
    drive.accessToken = "at-new";
    // 첫 토큰 발급은 at-old 로, 두 번째 갱신부터 at-new
    let first = true;
    drive.overrides.push((req) => {
      if (req.url.includes("oauth2") && first) {
        first = false;
        return Response.json({ access_token: "at-old", expires_in: 3599, token_type: "Bearer" });
      }
      return null;
    });
    await ensureBoardFolders(env, board.id);
    const auths = drive.driveCalls().map((c) => c.auth);
    expect(auths[0]).toBe("Bearer at-old");
    expect(auths[1]).toBe("Bearer at-new");
    expect(auths.at(-1)).toBe("Bearer at-new");
    expect(folders()).toHaveLength(3);
  });

  it("저장 공간이 가득 차면 storage_full (한국어 메시지)", async () => {
    drive.overrides.push((req) =>
      req.method === "POST" && req.url.startsWith("https://www.googleapis.com/") ? Response.json({ error: { code: 403, errors: [{ reason: "storageQuotaExceeded" }] } }, { status: 403 }) : null,
    );
    const e = await ensureBoardFolders(env, board.id).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(DriveError);
    expect((e as DriveError).code).toBe("storage_full");
    expect((e as DriveError).message).toContain("저장 공간");
  });

  it("rate limit·5xx 는 백오프 후 재시도", async () => {
    let n = 0;
    drive.overrides.push((req) => {
      if (req.url.startsWith("https://www.googleapis.com/") && n < 2) {
        n++;
        return n === 1
          ? Response.json({ error: { code: 403, errors: [{ reason: "userRateLimitExceeded" }] } }, { status: 403 })
          : new Response("oops", { status: 503 });
      }
      return null;
    });
    await ensureBoardFolders(env, board.id);
    expect(n).toBe(2);
    expect(folders()).toHaveLength(3);
  });

  it("refresh token 이 취소됐으면 reconnect", async () => {
    await invalidateGoogleAccessToken(env);
    drive.overrides.push((req) => (req.url.includes("oauth2") ? Response.json({ error: "invalid_grant" }, { status: 400 }) : null));
    const e = (await ensureBoardFolders(env, board.id).catch((x: unknown) => x)) as DriveError;
    expect(e.code).toBe("reconnect");
    expect(e.needsReconnect).toBe(true);
  });
});

describe("writeBoardBackup / renameBoardFolder", () => {
  it("처음엔 만들고, 다음엔 같은 파일을 갱신한다", async () => {
    await writeBoardBackup(env, board.id, { posts: [1] });
    const id = board.state.backupFileId!;
    const f = drive.files.get(id)!;
    expect(f.name).toBe("게시글 백업.json");
    expect(f.parents).toEqual([board.state.folderId]);
    expect(JSON.parse(new TextDecoder().decode(f.content))).toEqual({ posts: [1] });
    expect(board.state.lastBackupAt).toBeTypeOf("number");

    await writeBoardBackup(env, board.id, { posts: [1, 2] });
    expect(board.state.backupFileId).toBe(id);
    expect(JSON.parse(new TextDecoder().decode(drive.files.get(id)!.content))).toEqual({ posts: [1, 2] });
    expect([...drive.files.values()].filter((x) => x.name === "게시글 백업.json")).toHaveLength(1);
    expect(drive.driveCalls((c) => c.method === "PATCH" && c.url.includes("uploadType=media"))).toHaveLength(1);
  });

  it("백업 파일이 휴지통에 있으면 새로 만든다", async () => {
    await writeBoardBackup(env, board.id, { v: 1 });
    const id = board.state.backupFileId!;
    drive.files.get(id)!.trashed = true;
    await writeBoardBackup(env, board.id, { v: 2 });
    expect(board.state.backupFileId).not.toBe(id);
  });

  it("Board DO 안에서는 state/board 를 넘겨 자기 RPC 없이 쓸 수 있다", async () => {
    const other = new FakeBoard("b2", "XYZ789", "다른 보드");
    await writeBoardBackup(env, "b2", { a: 1 }, { state: other.getDriveState(), board: other });
    expect(other.state.backupFileId).toBeTruthy();
  });

  it("폴더 이름 바꾸기", async () => {
    await ensureBoardFolders(env, board.id);
    await renameBoardFolder(env, board.id, "4학년 과학");
    expect(drive.files.get(board.state.folderId!)!.name).toBe("4학년 과학 (ABC234)");
  });
});

// ---------------- 업로드 ----------------

function post(path: string, body: unknown, actor = "student:s1", extra: Record<string, string> = {}) {
  return call(path, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, "x-test-actor": actor, ...extra },
    body: JSON.stringify(body),
  });
}

async function startUpload(body: Record<string, unknown> = { name: "사진.webp", size: 5, mime: "image/webp", width: 10, height: 8 }) {
  const res = await post(`/api/boards/${board.code}/uploads`, body);
  expect(res.status).toBe(200);
  return (await res.json()) as CreateUploadResponse;
}

describe("POST /api/boards/:code/uploads", () => {
  it("Drive 세션을 브라우저 Origin 으로 만들고 주소를 준다 (접근 토큰은 안 줌)", async () => {
    const r = await startUpload();
    expect(r.mode).toBe("direct");
    expect(r.method).toBe("PUT");
    expect(r.uploadUrl).toMatch(/^https:\/\/www\.googleapis\.com\/upload\/drive\/v3\/files\?uploadType=resumable&upload_id=/);
    expect(r.fallback!.uploadUrl).toBe(`/api/boards/${board.code}/uploads/${encodeURIComponent(r.uploadId)}/proxy`);
    expect(JSON.stringify(r)).not.toContain("at-refreshed");
    const s = [...drive.sessions.values()][0]!;
    expect(s.origin).toBe(ORIGIN);
    expect(s.length).toBe(5);
    expect(s.metadata).toMatchObject({ name: "사진.webp", mimeType: "image/webp", parents: [board.state.attachFolderId], appProperties: { nanumboardBoard: "b1" } });
  });

  it("보드에 못 들어온 사람은 401", async () => {
    const res = await call(`/api/boards/${board.code}/uploads`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "a.png", size: 1, mime: "image/png" }),
    });
    expect(res.status).toBe(401);
  });

  it("잠긴 보드 등 정책이 거부하면 403 + 이유", async () => {
    board.policy = { ok: false, reason: "보드가 잠겨 있어요." };
    const res = await post(`/api/boards/${board.code}/uploads`, { name: "a.png", size: 1, mime: "image/png" });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe("보드가 잠겨 있어요.");
    expect(drive.sessions.size).toBe(0);
  });

  it("크기 초과는 413", async () => {
    board.policy = { ok: true, maxBytes: 1024 };
    const res = await post(`/api/boards/${board.code}/uploads`, { name: "a.pdf", size: 2048, mime: "application/pdf" });
    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: { message: string } }).error.message).toContain("1KB까지");
  });

  it("실행 파일은 415, 빈 이름·0바이트는 400/415", async () => {
    expect((await post(`/api/boards/${board.code}/uploads`, { name: "game.exe", size: 10, mime: "application/octet-stream" })).status).toBe(415);
    expect((await post(`/api/boards/${board.code}/uploads`, { name: "a.txt", size: 10, mime: "application/x-msdownload" })).status).toBe(415);
    expect((await post(`/api/boards/${board.code}/uploads`, { name: "  ", size: 10, mime: "text/plain" })).status).toBe(415);
    expect((await post(`/api/boards/${board.code}/uploads`, { name: "a.txt", size: 0, mime: "text/plain" })).status).toBe(400);
  });

  it("JSON 이 아니거나 다른 사이트 Origin 이면 거부", async () => {
    const r1 = await call(`/api/boards/${board.code}/uploads`, { method: "POST", headers: { "content-type": "text/plain", "x-test-actor": "student:s1" }, body: "{}" });
    expect(r1.status).toBe(415);
    const r2 = await post(`/api/boards/${board.code}/uploads`, { name: "a.png", size: 1, mime: "image/png" }, "student:s1", { origin: "https://evil.example" });
    expect(r2.status).toBe(403);
  });
});

/** 브라우저가 Drive 세션 주소로 직접 PUT 한 것을 흉내 */
async function browserPut(url: string, bytes: Uint8Array) {
  return (await drive.handle(new Request(url, { method: "PUT", body: bytes }))).json() as Promise<{ id: string }>;
}

describe("완료 확인 / 프록시", () => {
  it("직접 PUT 후 complete → 업로드 확인 토큰(purpose upload, payload UploadedFile)", async () => {
    const r = await startUpload();
    const { id } = await browserPut(r.uploadUrl, new Uint8Array([1, 2, 3, 4, 5]));
    const res = await post(`/api/boards/${board.code}/uploads/${encodeURIComponent(r.uploadId)}/complete`, { sessionUrl: r.uploadUrl, driveFileId: id });
    expect(res.status).toBe(200);
    const body = (await res.json()) as CompleteUploadResponse;
    const expected: UploadedFile = { boardId: "b1", by: "s1", driveFileId: id, name: "사진.webp", mime: "image/webp", size: 5, kind: "image", width: 10, height: 8 };
    expect(body.file).toEqual(expected);
    const claims = await verifyToken<UploadedFile>(await getSigningSecret(env), "upload", body.token);
    expect(claims).toMatchObject(expected);
  });

  it("응답을 못 읽었어도(driveFileId 없음) 세션 상태로 확인한다", async () => {
    const r = await startUpload();
    await browserPut(r.uploadUrl, new Uint8Array(5));
    const res = await post(`/api/boards/${board.code}/uploads/${encodeURIComponent(r.uploadId)}/complete`, { sessionUrl: r.uploadUrl });
    expect(res.status).toBe(200);
  });

  it("아직 안 올렸으면 409", async () => {
    const r = await startUpload();
    const res = await post(`/api/boards/${board.code}/uploads/${encodeURIComponent(r.uploadId)}/complete`, { sessionUrl: r.uploadUrl });
    expect(res.status).toBe(409);
  });

  it("보드 첨부 폴더 밖으로 옮겨진 파일은 거부", async () => {
    const r = await startUpload();
    const { id } = await browserPut(r.uploadUrl, new Uint8Array(5));
    drive.files.get(id)!.parents = ["somewhere-else"];
    const res = await post(`/api/boards/${board.code}/uploads/${encodeURIComponent(r.uploadId)}/complete`, { sessionUrl: r.uploadUrl, driveFileId: id });
    expect(res.status).toBe(422);
  });

  it("다른 파일 id 를 자기 것이라 주장하면 거부", async () => {
    const other = drive.addFile({ name: "남의 것", parents: [board.state.attachFolderId ?? "x"] });
    const r = await startUpload();
    await browserPut(r.uploadUrl, new Uint8Array(5));
    const res = await post(`/api/boards/${board.code}/uploads/${encodeURIComponent(r.uploadId)}/complete`, { sessionUrl: r.uploadUrl, driveFileId: other.id });
    expect(res.status).toBe(400);
  });

  it("세션 주소가 uploadId 와 안 맞거나 uploadId 가 위조·다른 보드면 거부", async () => {
    const r = await startUpload();
    const r2 = await startUpload();
    await browserPut(r2.uploadUrl, new Uint8Array(5));
    expect((await post(`/api/boards/${board.code}/uploads/${encodeURIComponent(r.uploadId)}/complete`, { sessionUrl: r2.uploadUrl })).status).toBe(400);
    expect((await post(`/api/boards/${board.code}/uploads/${encodeURIComponent(r.uploadId + "x")}/complete`, { sessionUrl: r.uploadUrl })).status).toBe(404);
    expect((await post(`/api/boards/ZZZ999/uploads/${encodeURIComponent(r.uploadId)}/complete`, { sessionUrl: r.uploadUrl })).status).toBe(404);
  });

  it("프록시 경로: Worker 가 같은 세션으로 흘려 보내고 complete 도 된다", async () => {
    const r = await startUpload();
    const fb = r.fallback!;
    const res = await call(fb.uploadUrl, { method: "PUT", headers: { ...fb.headers, "content-length": "5" }, body: new Uint8Array([9, 9, 9, 9, 9]) });
    expect(res.status).toBe(200);
    const { driveFileId } = (await res.json()) as { driveFileId: string };
    expect([...drive.files.get(driveFileId)!.content]).toEqual([9, 9, 9, 9, 9]);
    // 세션 주소 PUT 에는 교사 토큰을 붙이지 않는다
    const put = drive.calls.find((c) => c.method === "PUT")!;
    expect(put.auth).toBeNull();
    const done = await post(`/api/boards/${board.code}/uploads/${encodeURIComponent(r.uploadId)}/complete`, { sessionUrl: r.uploadUrl, driveFileId });
    expect(done.status).toBe(200);
  });

  it("프록시: 크기가 다르거나 세션 헤더가 없으면 400", async () => {
    const r = await startUpload();
    const fb = r.fallback!;
    expect((await call(fb.uploadUrl, { method: "PUT", headers: { ...fb.headers }, body: new Uint8Array(3) })).status).toBe(400);
    expect((await call(fb.uploadUrl, { method: "PUT", headers: { "content-type": "image/webp" }, body: new Uint8Array(5) })).status).toBe(400);
  });
});

// ---------------- 보기 ----------------

async function fileToken(boardId = board.id) {
  return signToken(await getSigningSecret(env), "file", { boardId }, 3600);
}

describe("GET /api/files/:boardId/:attachmentId", () => {
  const png = new Uint8Array(Array.from({ length: 100 }, (_, i) => i));
  beforeEach(() => {
    const f = drive.addFile({ id: "drv-img", name: "a.png", mimeType: "image/png", content: png });
    board.attachments.set("att1", { driveFileId: f.id, name: "그림.png", mime: "image/png", size: png.byteLength, kind: "image" });
    const h = drive.addFile({ id: "drv-html", name: "x.html", mimeType: "text/html", content: new TextEncoder().encode("<script>alert(1)</script>") });
    board.attachments.set("att2", { driveFileId: h.id, name: "숙제.html", mime: "text/html", size: 25, kind: "file" });
  });

  it("토큰이 없거나 틀리거나 다른 보드 것이면 거부", async () => {
    expect((await call(`/api/files/b1/att1`)).status).toBe(401);
    expect((await call(`/api/files/b1/att1?t=nope`)).status).toBe(401);
    expect((await call(`/api/files/b1/att1?t=${await fileToken("b2")}`)).status).toBe(403);
    const wrongPurpose = await signToken(await getSigningSecret(env), "upload", { boardId: "b1" }, 60);
    expect((await call(`/api/files/b1/att1?t=${wrongPurpose}`)).status).toBe(401);
    expect(drive.driveCalls((c) => c.url.includes("alt=media"))).toHaveLength(0);
  });

  it("이미지는 inline + nosniff + 비공개 장기 캐시, 두 번째는 캐시에서 (Drive 안 부름)", async () => {
    const t = await fileToken();
    const r1 = await call(`/api/files/b1/att1?t=${t}`);
    expect(r1.status).toBe(200);
    expect(r1.headers.get("content-type")).toBe("image/png");
    expect(r1.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r1.headers.get("content-disposition")).toMatch(/^inline; .*filename\*=UTF-8''%EA%B7%B8%EB%A6%BC\.png$/);
    expect(r1.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
    expect(new Uint8Array(await r1.arrayBuffer())).toEqual(png);
    expect(drive.driveCalls((c) => c.url.includes("alt=media"))).toHaveLength(1);

    // 다른 토큰으로 요청해도 같은 캐시 (키에 토큰 없음)
    const t2 = await signToken(await getSigningSecret(env), "file", { boardId: "b1", x: 1 }, 3600);
    const r2 = await call(`/api/files/b1/att1?t=${t2}`);
    expect(r2.status).toBe(200);
    expect(r2.headers.get("x-cache")).toBe("hit");
    expect(r2.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
    expect(new Uint8Array(await r2.arrayBuffer())).toEqual(png);
    expect(drive.driveCalls((c) => c.url.includes("alt=media"))).toHaveLength(1);
    expect(board.attachmentCalls).toBe(1);
  });

  it("Range 요청은 206 과 Content-Range 를 그대로", async () => {
    const res = await call(`/api/files/b1/att1?t=${await fileToken()}`, { headers: { range: "bytes=10-19" } });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 10-19/100");
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual(Array.from({ length: 10 }, (_, i) => i + 10));
    const media = drive.driveCalls((c) => c.url.includes("alt=media"));
    expect(media).toHaveLength(1);
  });

  it("html 같은 위험한 형식은 내려받기로, 실행 안 되게", async () => {
    const res = await call(`/api/files/b1/att2?t=${await fileToken()}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment;/);
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
    await res.arrayBuffer();
  });

  it("보드에 없는 첨부·드라이브에서 지워진 파일은 404", async () => {
    const t = await fileToken();
    expect((await call(`/api/files/b1/nope?t=${t}`)).status).toBe(404);
    drive.files.delete("drv-img");
    const res = await call(`/api/files/b1/att1?t=${t}`);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { message: string } }).error.message).toContain("드라이브");
  });
});

// ---------------- 내보내기·상태 ----------------

describe("내보내기 / 드라이브 상태", () => {
  it("CSV 는 수식 주입을 막고 따옴표를 이스케이프", () => {
    expect(toCsv(["a", "b"], [["=1+1", 'x "y", z']])).toBe('a,b\r\n\'=1+1,"x ""y"", z"\r\n');
  });

  it("교사만, 보드 폴더에 구글 시트로 변환 업로드하고 링크를 준다", async () => {
    expect((await call(`/api/boards/${board.code}/export`, { method: "POST" })).status).toBe(401);
    const res = await call(`/api/boards/${board.code}/export`, { method: "POST", ...withSession(session) });
    expect(res.status).toBe(200);
    const { url } = (await res.json()) as { url: string };
    const sheet = [...drive.files.values()].find((f) => f.mimeType === "application/vnd.google-apps.spreadsheet")!;
    expect(url).toBe(`https://docs.google.com/fake/${sheet.id}`);
    expect(sheet.parents).toEqual([board.state.folderId]);
    expect(sheet.name).toMatch(/^3학년 과학 내보내기 \d{4}-\d\d-\d\d \d\d:\d\d$/);
    const csv = new TextDecoder().decode(sheet.content);
    expect(csv.split("\r\n")[0]).toBe("번호,이름,내용");
    expect(csv).toContain("'=1+1");
  });

  it("없는 보드는 404", async () => {
    expect((await call(`/api/boards/NOPE22/export`, { method: "POST", ...withSession(session) })).status).toBe(404);
  });

  it("GET drive: 폴더 주소와 백업 상태", async () => {
    expect((await call(`/api/boards/${board.code}/drive`)).status).toBe(401);
    let r = (await (await call(`/api/boards/${board.code}/drive`, withSession(session))).json()) as { folderUrl: string | null; backup: { status: string } };
    expect(r).toEqual({ folderUrl: null, backup: { status: "never", lastAt: null } });
    await writeBoardBackup(env, board.id, {});
    r = (await (await call(`/api/boards/${board.code}/drive`, withSession(session))).json()) as typeof r;
    expect(r.folderUrl).toBe(`https://drive.google.com/drive/folders/${board.state.folderId}`);
    expect(r.backup.status).toBe("ok");
    board.state.backupError = "드라이브가 가득 찼어요";
    r = (await (await call(`/api/boards/${board.code}/drive`, withSession(session))).json()) as typeof r;
    expect(r.backup).toMatchObject({ status: "error", error: "드라이브가 가득 찼어요" });
  });
});
