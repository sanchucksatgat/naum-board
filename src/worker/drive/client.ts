/**
 * 작은 Google Drive REST v3 클라이언트 (fetch 기반, SDK 없음).
 * - 인증: getGoogleAccessToken (교사 refresh token). 접근 토큰은 절대 브라우저로 보내지 않는다.
 * - 401 → 토큰 무효화 후 한 번 재시도
 * - 403 rate limit / 429 / 5xx → 짧은 지수 백오프로 최대 2번 재시도 (본문이 스트림이면 재시도 안 함)
 * - 실패는 DriveError(한국어 메시지)로 던진다.
 *
 * 무료 요금제 주의: 요청당 서브요청 50개. 재시도도 서브요청이므로 재시도 횟수를 작게 둔다.
 */
import type { Env } from "../env";
import { GoogleAccessError, getGoogleAccessToken, invalidateGoogleAccessToken } from "../auth";
import { DriveError, type DriveErrorCode } from "./errors";

export const DRIVE_API = "https://www.googleapis.com/drive/v3";
export const DRIVE_UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";
export const FOLDER_MIME = "application/vnd.google-apps.folder";
export const SHEET_MIME = "application/vnd.google-apps.spreadsheet";

/** 테스트에서 줄일 수 있게 export */
export const driveRetryConfig = { retries: 2, baseMs: 250, maxRetryAfterMs: 2000 };

export type DriveBody = string | ArrayBuffer | Uint8Array | ReadableStream<Uint8Array> | null;

export interface DriveRequestInit {
  method?: string;
  headers?: Record<string, string>;
  body?: DriveBody;
  /** 이 상태들은 오류로 던지지 않고 Response 를 그대로 돌려준다 (예: 404 를 직접 처리할 때) */
  allowStatus?: number[];
}

interface GoogleErrorBody {
  error?: { code?: number; message?: string; status?: string; errors?: { reason?: string }[] };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function accessToken(env: Env): Promise<string> {
  try {
    return await getGoogleAccessToken(env);
  } catch (e) {
    throw fromAccessError(e);
  }
}

function fromAccessError(e: unknown): unknown {
  if (!(e instanceof GoogleAccessError)) return e;
  if (e.reason === "reconnect_required") return new DriveError("reconnect");
  if (e.reason === "google_error") return new DriveError("unavailable");
  return new DriveError("not_configured");
}

async function readGoogleError(res: Response): Promise<{ reason?: string; status?: string }> {
  try {
    const j = (await res.clone().json()) as GoogleErrorBody;
    return { reason: j.error?.errors?.[0]?.reason, status: j.error?.status };
  } catch {
    return {};
  }
}

/** Google 이 "이 프로젝트에서 Drive API 를 켜지 않았다"고 할 때 주는 reason */
export const API_DISABLED_REASONS = new Set(["accessNotConfigured", "SERVICE_DISABLED"]);
const RATE_REASONS = new Set(["rateLimitExceeded", "userRateLimitExceeded", "backendError", "sharingRateLimitExceeded"]);
const QUOTA_REASONS = new Set(["storageQuotaExceeded", "quotaExceeded", "teamDriveFileLimitExceeded", "numChildrenInNonRootLimitExceeded"]);

/** 실패 응답을 DriveError 로 분류. retryable 이면 같은 요청을 다시 보내 볼 만하다. */
export async function classifyDriveFailure(res: Response): Promise<{ error: DriveError; retryable: boolean }> {
  const { reason, status } = await readGoogleError(res);
  const mk = (code: DriveErrorCode) => new DriveError(code, res.status, reason);
  if (res.status === 401) return { error: mk("reconnect"), retryable: false };
  if (res.status === 404) return { error: mk("not_found"), retryable: false };
  if (res.status === 429) return { error: mk("rate_limited"), retryable: true };
  if (res.status === 403) {
    if (reason && QUOTA_REASONS.has(reason)) return { error: mk("storage_full"), retryable: false };
    if (reason && RATE_REASONS.has(reason)) return { error: mk("rate_limited"), retryable: true };
    // 교사의 Google Cloud 프로젝트에서 Drive API 를 켜지 않음 (토큰은 발급되지만 모든 Drive 호출이 403)
    if (reason && API_DISABLED_REASONS.has(reason)) return { error: mk("api_disabled"), retryable: false };
    // drive.file 권한을 빼고 로그인한 경우
    if (status === "PERMISSION_DENIED" && reason === "insufficientPermissions") return { error: mk("reconnect"), retryable: false };
    if (reason === "ACCESS_TOKEN_SCOPE_INSUFFICIENT" || status === "ACCESS_TOKEN_SCOPE_INSUFFICIENT") return { error: mk("reconnect"), retryable: false };
    return { error: mk("forbidden"), retryable: false };
  }
  if (res.status >= 500) return { error: mk("unavailable"), retryable: true };
  return { error: mk("bad_request"), retryable: false };
}

function retryDelay(res: Response | null, attempt: number): number {
  const ra = res?.headers.get("retry-after");
  if (ra && /^\d+$/.test(ra)) return Math.min(Number(ra) * 1000, driveRetryConfig.maxRetryAfterMs);
  const base = driveRetryConfig.baseMs * 2 ** attempt;
  return base + Math.floor(Math.random() * base * 0.3);
}

/**
 * Drive API 호출. 성공(2xx·3xx 또는 allowStatus)이면 Response, 아니면 DriveError 를 던진다.
 * @param url DRIVE_API / DRIVE_UPLOAD_API 로 시작하는 전체 주소
 */
export async function driveFetch(env: Env, url: string, init: DriveRequestInit = {}): Promise<Response> {
  const resendable = !(init.body instanceof ReadableStream);
  let refreshed = false;
  let attempt = 0;
  for (;;) {
    const token = await accessToken(env);
    let res: Response;
    try {
      res = await fetch(url, {
        method: init.method ?? "GET",
        headers: { ...init.headers, authorization: `Bearer ${token}` },
        body: init.body ?? null,
      });
    } catch (e) {
      if (resendable && attempt < driveRetryConfig.retries) {
        await sleep(retryDelay(null, attempt++));
        continue;
      }
      console.warn("drive network error", e);
      throw new DriveError("unavailable");
    }
    if (res.ok || (res.status >= 300 && res.status < 400) || init.allowStatus?.includes(res.status)) return res;

    if (res.status === 401 && !refreshed && resendable) {
      refreshed = true;
      try {
        await invalidateGoogleAccessToken(env);
      } catch (e) {
        throw fromAccessError(e);
      }
      continue;
    }
    const { error, retryable } = await classifyDriveFailure(res);
    if (retryable && resendable && attempt < driveRetryConfig.retries) {
      await sleep(retryDelay(res, attempt++));
      continue;
    }
    throw error;
  }
}

/** JSON 응답을 받는 Drive 호출 */
export async function driveJson<T>(env: Env, url: string, init: DriveRequestInit = {}): Promise<T> {
  const res = await driveFetch(env, url, init);
  return (await res.json()) as T;
}

// ---- 자주 쓰는 동작 ----

export interface DriveFile {
  id: string;
  name?: string;
  mimeType?: string;
  /** 바이트 (문자열로 옴) */
  size?: string;
  parents?: string[];
  trashed?: boolean;
  appProperties?: Record<string, string>;
  webViewLink?: string;
  createdTime?: string;
  imageMediaMetadata?: { width?: number; height?: number; rotation?: number };
}

export const FILE_FIELDS = "id,name,mimeType,size,parents,trashed,appProperties,createdTime,imageMediaMetadata(width,height,rotation)";

/** Drive 쿼리 문자열 안에 넣을 값 이스케이프 */
export function q(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

/** 파일 메타데이터. 없으면(404) null */
export async function getFile(env: Env, id: string, fields = FILE_FIELDS): Promise<DriveFile | null> {
  const res = await driveFetch(env, `${DRIVE_API}/files/${encodeURIComponent(id)}?fields=${encodeURIComponent(fields)}`, { allowStatus: [404] });
  if (res.status === 404) return null;
  return (await res.json()) as DriveFile;
}

/** 이 앱이 만든 파일 중 조건에 맞는 것 (drive.file 범위라 앱이 만든 것만 보인다) */
export async function listFiles(env: Env, query: string, fields = "files(id,name,parents,trashed)", pageSize = 10): Promise<DriveFile[]> {
  const url = `${DRIVE_API}/files?q=${encodeURIComponent(query)}&fields=${encodeURIComponent(fields)}&pageSize=${pageSize}&spaces=drive`;
  const r = await driveJson<{ files?: DriveFile[] }>(env, url);
  return r.files ?? [];
}

export async function createFolder(env: Env, name: string, parentId: string | null, appProperties: Record<string, string>): Promise<DriveFile> {
  return driveJson<DriveFile>(env, `${DRIVE_API}/files?fields=id,name,parents`, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ name, mimeType: FOLDER_MIME, ...(parentId ? { parents: [parentId] } : {}), appProperties }),
  });
}

export async function updateMetadata(env: Env, id: string, patch: Record<string, unknown>, fields = "id"): Promise<DriveFile | null> {
  const res = await driveFetch(env, `${DRIVE_API}/files/${encodeURIComponent(id)}?fields=${encodeURIComponent(fields)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(patch),
    allowStatus: [404],
  });
  if (res.status === 404) return null;
  return (await res.json()) as DriveFile;
}

/** multipart 업로드 (작은 파일: 백업 JSON, 내보내기 CSV) */
export async function uploadMultipart(
  env: Env,
  metadata: Record<string, unknown>,
  content: string,
  contentType: string,
  fields = "id",
): Promise<DriveFile> {
  const boundary = `nb${crypto.randomUUID().replace(/-/g, "")}`;
  const body =
    `--${boundary}\r\ncontent-type: application/json; charset=utf-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\ncontent-type: ${contentType}\r\n\r\n${content}\r\n--${boundary}--`;
  return driveJson<DriveFile>(env, `${DRIVE_UPLOAD_API}/files?uploadType=multipart&fields=${encodeURIComponent(fields)}`, {
    method: "POST",
    headers: { "content-type": `multipart/related; boundary=${boundary}` },
    body,
  });
}

/** 기존 파일 내용 교체 (media). 없으면 null */
export async function updateMedia(env: Env, id: string, content: string, contentType: string, fields = "id,trashed"): Promise<DriveFile | null> {
  const res = await driveFetch(env, `${DRIVE_UPLOAD_API}/files/${encodeURIComponent(id)}?uploadType=media&fields=${encodeURIComponent(fields)}`, {
    method: "PATCH",
    headers: { "content-type": contentType },
    body: content,
    allowStatus: [404],
  });
  if (res.status === 404) return null;
  return (await res.json()) as DriveFile;
}

export const folderUrl = (id: string) => `https://drive.google.com/drive/folders/${encodeURIComponent(id)}`;
export const sheetUrl = (id: string) => `https://docs.google.com/spreadsheets/d/${encodeURIComponent(id)}/edit`;
