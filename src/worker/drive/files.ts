/**
 * 첨부 보기: GET /api/files/:boardId/:attachmentId?t={파일 보기 토큰}
 * 토큰 확인 → Cache API(키에 토큰 없음) → Board.getAttachment → Drive alt=media 스트리밍.
 * Drive 파일은 공개 공유하지 않고 언제나 Worker 를 거친다.
 *
 * 주의(미확인 아님, 문서상 사실): Cache API 는 workers.dev 하위 도메인에서는 저장이 되지 않는다(put 이 무시됨).
 * 사용자 지정 도메인에서만 캐시 효과가 있다. 동작은 둘 다 정상.
 */
import type { Env } from "../env";
import { HttpError } from "../http";
import { getSigningSecret, verifyToken } from "../auth";
import { FILE_VIEW_TOKEN_PURPOSE, type FileViewTokenPayload } from "../../shared/files";
import { driveFetch, DRIVE_API } from "./client";
import { DriveError } from "./errors";
import { getDriveDeps } from "./deps";
import { contentDisposition, isInlineSafe } from "./policy";

/** 이보다 큰 파일은 캐시에 넣지 않는다 (영상 등은 Range 로 Drive 에서 바로) */
export const CACHE_MAX_BYTES = 10 * 1024 * 1024;
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

function cacheKey(origin: string, boardId: string, attachmentId: string): Request {
  return new Request(`${origin}/__file-cache/v1/${encodeURIComponent(boardId)}/${encodeURIComponent(attachmentId)}`);
}

function safeHeaders(mime: string, name: string, size: number | null): Headers {
  const inline = isInlineSafe(mime);
  const h = new Headers({
    "content-type": inline ? mime : mime.startsWith("text/") ? "text/plain; charset=utf-8" : "application/octet-stream",
    "content-disposition": contentDisposition(inline ? "inline" : "attachment", name),
    "x-content-type-options": "nosniff",
    // 혹시 브라우저가 문서로 열더라도 스크립트·외부 자원 차단
    "content-security-policy": "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox",
    "cross-origin-resource-policy": "same-origin",
    "referrer-policy": "no-referrer",
    // 첨부는 한 번 올리면 바뀌지 않는다. 토큰 붙은 주소라 공유 캐시에는 두지 않는다.
    "cache-control": "private, max-age=31536000, immutable",
    "accept-ranges": "bytes",
  });
  if (size !== null) h.set("content-length", String(size));
  return h;
}

export async function serveFile(request: Request, env: Env, ctx: ExecutionContext | undefined, boardId: string, attachmentId: string): Promise<Response> {
  if (!ID_RE.test(boardId) || !ID_RE.test(attachmentId)) throw new HttpError(404, "not_found", "파일을 찾을 수 없어요.");
  const url = new URL(request.url);
  const claims = await verifyToken<FileViewTokenPayload>(await getSigningSecret(env), FILE_VIEW_TOKEN_PURPOSE, url.searchParams.get("t"));
  if (!claims) throw new HttpError(401, "file_token_invalid", "파일을 볼 수 있는 시간이 지났어요. 보드를 새로 고쳐 주세요.");
  if (claims.boardId !== boardId) throw new HttpError(403, "forbidden", "이 파일을 볼 수 없어요.");

  const etag = `"${attachmentId}"`;
  if (request.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers: { etag, "cache-control": "private, max-age=31536000, immutable" } });
  }

  const range = request.headers.get("range");
  const cache = (caches as unknown as { default: Cache }).default;
  const key = cacheKey(url.origin, boardId, attachmentId);
  if (!range) {
    const hit = await cache.match(key);
    if (hit) {
      const res = new Response(hit.body, hit);
      res.headers.set("cache-control", "private, max-age=31536000, immutable");
      res.headers.set("x-cache", "hit");
      return res;
    }
  }

  const att = await getDriveDeps().board(env, boardId).getAttachment(attachmentId);
  if (!att) throw new HttpError(404, "not_found", "파일을 찾을 수 없어요.");

  let upstream: Response;
  try {
    upstream = await driveFetch(env, `${DRIVE_API}/files/${encodeURIComponent(att.driveFileId)}?alt=media`, {
      headers: range ? { range } : {},
      allowStatus: [416],
    });
  } catch (e) {
    if (e instanceof DriveError && e.code === "not_found") {
      throw new HttpError(404, "drive_not_found", "드라이브에서 파일을 찾을 수 없어요. 선생님이 지웠을 수 있어요.");
    }
    throw e instanceof DriveError ? e.toHttpError() : e;
  }

  if (upstream.status === 416) {
    return new Response(null, { status: 416, headers: { "content-range": upstream.headers.get("content-range") ?? `bytes */${att.size}` } });
  }
  const len = upstream.headers.get("content-length");
  const headers = safeHeaders(att.mime, att.name, len !== null && /^\d+$/.test(len) ? Number(len) : null);
  headers.set("etag", etag);
  if (upstream.status === 206) {
    const cr = upstream.headers.get("content-range");
    if (cr) headers.set("content-range", cr);
    return new Response(upstream.body, { status: 206, headers });
  }

  const res = new Response(upstream.body, { status: 200, headers });
  if (att.size <= CACHE_MAX_BYTES && upstream.body) {
    const [toClient, toCache] = upstream.body.tee();
    const cached = new Response(toCache, { status: 200, headers: new Headers(headers) });
    // 엣지 캐시 보관 기간: 보드에서 지운 첨부가 오래 남지 않게 하루
    cached.headers.set("cache-control", "public, max-age=86400");
    const put = cache.put(key, cached).catch((e: unknown) => console.warn("file cache put failed", e));
    if (ctx) ctx.waitUntil(put);
    const out = new Response(toClient, { status: 200, headers });
    out.headers.set("x-cache", "miss");
    return out;
  }
  return res;
}
