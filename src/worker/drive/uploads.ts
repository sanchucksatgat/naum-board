/**
 * 업로드 (§7, §10). 서버에 상태를 남기지 않는다(DO 요청 절약):
 * uploadId 자체가 서명 토큰(purpose "upload-session")이고, 그 안에 보드·작성자·이름·크기·MIME·첨부 폴더와
 * Drive 세션 주소의 해시가 들어 있다. 세션 주소(=이 파일 하나만 올릴 수 있는 권한)는 요청한 사람에게만 준다.
 * 교사 접근 토큰은 브라우저로 나가지 않는다.
 *
 * 1) POST /api/boards/:code/uploads          → Drive resumable 세션 생성(Origin 포함), 주소 반환
 * 2a) 브라우저 → Drive 세션 주소로 직접 PUT  (CORS 가 되면)
 * 2b) 브라우저 → PUT /api/boards/:code/uploads/:uploadId/proxy → Worker 가 같은 세션으로 스트리밍 (대체 경로)
 * 3) POST /api/boards/:code/uploads/:uploadId/complete → 세션 상태로 fileId 확인 + files.get 으로 폴더·크기·MIME 검증
 *    → 업로드 확인 토큰(purpose "upload", payload UploadedFile)
 */
import type { Env } from "../env";
import { HttpError } from "../http";
import { getSigningSecret, signToken, verifyToken, base64UrlEncode } from "../auth";
import {
  UPLOAD_TOKEN_PURPOSE,
  UPLOAD_TOKEN_TTL_SECONDS,
  type CompleteUploadResponse,
  type CreateUploadResponse,
  type UploadedFile,
} from "../../shared/files";
import { classifyDriveFailure, driveFetch, DRIVE_UPLOAD_API, getFile, FILE_FIELDS } from "./client";
import { DriveError } from "./errors";
import { getDriveDeps } from "./deps";
import { ensureBoardFolders } from "./folders";
import { checkUploadFile, formatMB } from "./policy";

export const UPLOAD_SESSION_PURPOSE = "upload-session";
/** Drive 세션은 1주일 유효하지만 우리는 하루로 묶는다 */
export const UPLOAD_SESSION_TTL_SECONDS = 24 * 60 * 60;
/** Workers 무료 요금제 요청 본문 한도(100MB) 때문에 프록시 경로가 감당할 수 있는 절대 상한 */
export const ABSOLUTE_MAX_BYTES = 95 * 1024 * 1024;
export const SESSION_HEADER = "x-upload-session";

/** uploadId 토큰 클레임 (짧은 키로 길이 절약) */
interface SessionClaims {
  b: string; // boardId
  c: string; // code
  by: string; // actor ref
  n: string; // name
  s: number; // size
  m: string; // mime
  k: "image" | "file";
  f: string; // attach folder id
  h: string; // sha256(sessionUrl) 앞부분
  w?: number;
  ht?: number;
}

async function sessionHash(url: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(url));
  return base64UrlEncode(d).slice(0, 32);
}

function isDriveSessionUrl(u: string): boolean {
  try {
    const url = new URL(u);
    return url.protocol === "https:" && url.hostname === "www.googleapis.com" && url.pathname.startsWith("/upload/drive/");
  } catch {
    return false;
  }
}

/** 브라우저가 업로드할 페이지의 출처. Drive 는 세션을 만든 요청의 Origin 에 대해서만 CORS 헤더를 준다. */
export function pageOrigin(request: Request): string {
  const url = new URL(request.url);
  const o = request.headers.get("origin");
  if (o) {
    try {
      const ou = new URL(o);
      const local = (h: string) => h === "localhost" || h === "127.0.0.1";
      if (ou.host === url.host || (local(url.hostname) && local(ou.hostname))) return ou.origin;
    } catch {
      /* 무시 */
    }
  }
  return url.origin;
}

function positiveInt(v: unknown, max: number): number | undefined {
  return typeof v === "number" && Number.isInteger(v) && v > 0 && v <= max ? v : undefined;
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const j = await request.json();
    if (j && typeof j === "object" && !Array.isArray(j)) return j as Record<string, unknown>;
  } catch {
    /* 아래에서 */
  }
  throw new HttpError(400, "bad_request", "요청 내용이 올바르지 않아요.");
}

async function readSession(env: Env, code: string, uploadId: string): Promise<SessionClaims & { iat: number }> {
  const claims = await verifyToken<SessionClaims>(await getSigningSecret(env), UPLOAD_SESSION_PURPOSE, uploadId);
  if (!claims || claims.c !== code) throw new HttpError(404, "upload_not_found", "업로드 정보를 찾을 수 없어요. 처음부터 다시 올려 주세요.");
  return claims;
}

async function checkSessionUrl(claims: SessionClaims, sessionUrl: unknown): Promise<string> {
  if (typeof sessionUrl !== "string" || !isDriveSessionUrl(sessionUrl) || (await sessionHash(sessionUrl)) !== claims.h) {
    throw new HttpError(400, "bad_session", "업로드 정보가 맞지 않아요. 처음부터 다시 올려 주세요.");
  }
  return sessionUrl;
}

// ---- 1) 세션 만들기 ----

export async function createUpload(request: Request, env: Env, code: string): Promise<CreateUploadResponse> {
  const deps = getDriveDeps();
  const body = await readJson(request);
  const check = checkUploadFile(body.name, body.mime);
  if (!check.ok) throw new HttpError(415, "file_type_blocked", check.message);
  const size = typeof body.size === "number" && Number.isInteger(body.size) ? body.size : NaN;
  if (!(size > 0)) throw new HttpError(400, "bad_size", "내용이 있는 파일을 골라 주세요.");

  const actor = await deps.authenticateBoardActor(request, env, code);
  if (!actor) throw new HttpError(401, "unauthorized", "보드에 다시 들어와 주세요.");
  const board = deps.board(env, actor.boardId);
  const policy = await board.getUploadPolicy(actor);
  if (!policy.ok) throw new HttpError(403, "upload_not_allowed", policy.reason);
  const maxBytes = Math.min(policy.maxBytes, ABSOLUTE_MAX_BYTES);
  if (size > maxBytes) throw new HttpError(413, "too_large", `파일이 너무 커요. 한 파일에 ${formatMB(maxBytes)}까지 올릴 수 있어요.`);

  let folders: { folderId: string; attachFolderId: string };
  let sessionUrl: string | null;
  try {
    folders = await ensureBoardFolders(env, actor.boardId);
    const res = await driveFetch(env, `${DRIVE_UPLOAD_API}/files?uploadType=resumable&fields=${encodeURIComponent(FILE_FIELDS)}`, {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=utf-8",
        "x-upload-content-type": check.mime,
        "x-upload-content-length": String(size),
        // 이 Origin 으로 시작한 세션이어야 브라우저 직접 PUT 에 CORS 헤더가 붙는다
        origin: pageOrigin(request),
      },
      body: JSON.stringify({
        name: check.name,
        mimeType: check.mime,
        parents: [folders.attachFolderId],
        appProperties: { nanumboardBoard: actor.boardId },
      }),
    });
    sessionUrl = res.headers.get("location");
  } catch (e) {
    throw e instanceof DriveError ? e.toHttpError() : e;
  }
  if (!sessionUrl || !isDriveSessionUrl(sessionUrl)) {
    console.error("drive resumable: no/odd Location header");
    throw new DriveError("unavailable").toHttpError();
  }

  const claims: SessionClaims = {
    b: actor.boardId,
    c: code,
    by: actor.ref,
    n: check.name,
    s: size,
    m: check.mime,
    k: check.kind,
    f: folders.attachFolderId,
    h: await sessionHash(sessionUrl),
  };
  if (check.kind === "image") {
    const w = positiveInt(body.width, 20000);
    const ht = positiveInt(body.height, 20000);
    if (w && ht) Object.assign(claims, { w, ht });
  }
  const uploadId = await signToken(await getSigningSecret(env), UPLOAD_SESSION_PURPOSE, claims, UPLOAD_SESSION_TTL_SECONDS);
  const headers = { "content-type": check.mime };
  return {
    uploadId,
    uploadUrl: sessionUrl,
    method: "PUT",
    headers,
    mode: "direct",
    fallback: {
      uploadUrl: `/api/boards/${encodeURIComponent(code)}/uploads/${encodeURIComponent(uploadId)}/proxy`,
      method: "PUT",
      headers: { ...headers, [SESSION_HEADER]: sessionUrl },
    },
  };
}

// ---- 2b) 프록시 ----

/** Drive 세션 주소로 응답을 받아 fileId 를 꺼낸다 (proxy·complete 공용) */
async function sessionResult(res: Response): Promise<{ id: string } | null> {
  if (res.status === 200 || res.status === 201) {
    const j = (await res.json().catch(() => null)) as { id?: unknown } | null;
    if (j && typeof j.id === "string") return { id: j.id };
    throw new DriveError("unavailable", res.status);
  }
  return null;
}

async function sessionFailure(res: Response): Promise<never> {
  if (res.status === 308) throw new HttpError(409, "upload_incomplete", "파일이 아직 다 올라가지 않았어요. 다시 올려 주세요.");
  if (res.status === 404 || res.status === 410) throw new HttpError(410, "upload_expired", "업로드 시간이 지났어요. 처음부터 다시 올려 주세요.");
  const { error } = await classifyDriveFailure(res);
  throw error.toHttpError();
}

export async function proxyUpload(request: Request, env: Env, code: string, uploadId: string): Promise<{ driveFileId: string }> {
  const claims = await readSession(env, code, uploadId);
  const sessionUrl = await checkSessionUrl(claims, request.headers.get(SESSION_HEADER));
  const len = Number(request.headers.get("content-length"));
  if (!request.body || !Number.isInteger(len) || len !== claims.s) {
    throw new HttpError(400, "bad_size", "파일 크기가 처음 알려 준 크기와 달라요. 다시 올려 주세요.");
  }
  // 크기를 고정한 스트림으로 그대로 흘려 보낸다 (Worker 메모리·CPU 를 거의 쓰지 않음)
  const fixed = new FixedLengthStream(len);
  const pump = request.body.pipeTo(fixed.writable).catch(() => {});
  let res: Response;
  try {
    res = await fetch(sessionUrl, { method: "PUT", headers: { "content-type": claims.m }, body: fixed.readable });
  } catch (e) {
    console.warn("proxy upload network error", e);
    throw new DriveError("unavailable").toHttpError();
  }
  await pump;
  const r = await sessionResult(res).catch((e: unknown) => {
    throw e instanceof DriveError ? e.toHttpError() : e;
  });
  if (r) return { driveFileId: r.id };
  return sessionFailure(res);
}

// ---- 3) 완료 확인 ----

export async function completeUpload(request: Request, env: Env, code: string, uploadId: string): Promise<CompleteUploadResponse> {
  const claims = await readSession(env, code, uploadId);
  const body = await readJson(request);
  const sessionUrl = await checkSessionUrl(claims, body.sessionUrl);
  const reported = typeof body.driveFileId === "string" && body.driveFileId.length < 200 ? body.driveFileId : undefined;

  // 세션 상태 확인: 이 세션으로 만들어진 파일 id 를 Drive 에게 직접 듣는다 (다른 사람 파일을 자기 것이라 주장하지 못하게).
  let res: Response | null = null;
  for (let i = 0; i < 2 && !res; i++) {
    try {
      const r = await fetch(sessionUrl, { method: "PUT", headers: { "content-range": `bytes */${claims.s}`, "content-length": "0" } });
      if (r.status >= 500 && i === 0) continue;
      res = r;
    } catch (e) {
      if (i === 1) {
        console.warn("upload status network error", e);
        throw new DriveError("unavailable").toHttpError();
      }
    }
  }
  if (!res) throw new DriveError("unavailable").toHttpError();
  let fromSession: { id: string } | null;
  try {
    fromSession = await sessionResult(res);
  } catch (e) {
    throw e instanceof DriveError ? e.toHttpError() : e;
  }
  if (!fromSession) await sessionFailure(res);
  const fileId = fromSession!.id;
  if (reported && reported !== fileId) throw new HttpError(400, "file_mismatch", "업로드한 파일 정보가 맞지 않아요. 다시 올려 주세요.");

  // 교사 권한으로 실제 파일 확인: 이 보드 첨부 폴더 안인지, 크기·MIME 이 신청한 대로인지
  const f = await getFile(env, fileId).catch((e: unknown) => {
    throw e instanceof DriveError ? e.toHttpError() : e;
  });
  const bad = (why: string) => {
    console.warn("upload verify failed", why);
    return new HttpError(422, "upload_verify_failed", "올린 파일을 확인하지 못했어요. 다시 올려 주세요.");
  };
  if (!f || f.trashed) throw bad("missing/trashed");
  if (!f.parents?.includes(claims.f)) throw bad("parent");
  if (f.appProperties?.nanumboardBoard !== claims.b) throw bad("board mark");
  if (Number(f.size) !== claims.s) throw bad("size");
  if (f.mimeType !== claims.m) throw bad("mime");

  const file: UploadedFile = {
    boardId: claims.b,
    by: claims.by,
    driveFileId: fileId,
    name: claims.n,
    mime: claims.m,
    size: claims.s,
    kind: claims.k,
  };
  if (claims.k === "image") {
    const meta = f.imageMediaMetadata;
    let w = meta?.width ?? claims.w;
    let h = meta?.height ?? claims.ht;
    // Drive 의 rotation(90° 단위)이 홀수면 화면상 가로세로가 바뀐다
    if (meta?.width && meta?.height && (meta.rotation ?? 0) % 2 === 1) [w, h] = [h, w];
    if (w && h) Object.assign(file, { width: w, height: h });
  }
  const token = await signToken(await getSigningSecret(env), UPLOAD_TOKEN_PURPOSE, file, UPLOAD_TOKEN_TTL_SECONDS);
  return { token, file };
}
