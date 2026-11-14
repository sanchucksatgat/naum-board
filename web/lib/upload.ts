/**
 * 브라우저 업로드 도우미 (프레임워크 없음). 학생·교사 화면이 같이 쓴다.
 *
 *   const { token, file } = await uploadAttachment(code, pickedFile, { onProgress: (p) => ..., signal });
 *   // token 을 post.save 메시지의 첨부에 넣는다 (업로드 확인 토큰)
 *
 * 흐름 (docs/DESIGN.md §7):
 *  1) 사진이면 긴 변 1600px, WebP(안 되면 JPEG)로 줄인다. GIF·작은 사진은 그대로.
 *  2) POST /api/boards/:code/uploads → Drive 업로드 세션
 *  3) Drive 로 직접 PUT. CORS/네트워크로 막히면(한 바이트도 안 갔을 때) 자동으로 Worker 프록시로 같은 세션에 PUT.
 *     한 번 막힌 브라우저는 이후 업로드부터 바로 프록시를 쓴다.
 *  4) POST .../complete → 서버가 Drive 에서 파일을 확인하고 업로드 확인 토큰을 준다.
 *  중간에 끊기면 새 세션으로 처음부터 다시(기본 2번) 시도한다.
 */
import type {
  CompleteUploadResponse,
  CreateUploadRequest,
  CreateUploadResponse,
  UploadedFile,
} from "../../src/shared/files";

export const MAX_EDGE = 1600;
/** 이보다 작은 사진(그리고 1600px 이하)은 압축하지 않는다 */
export const SMALL_IMAGE_BYTES = 300 * 1024;
const WEBP_QUALITY = 0.82;
const JPEG_QUALITY = 0.85;
/** 브라우저가 열 수 있는 원본 사진 상한 (메모리 보호) */
const MAX_SOURCE_IMAGE_BYTES = 40 * 1024 * 1024;

export type UploadPhase = "compress" | "upload" | "verify";

export interface UploadProgress {
  phase: UploadPhase;
  /** 0~1 (upload 단계에서만 의미 있음) */
  fraction: number;
  loaded: number;
  total: number;
}

export interface UploadOptions {
  onProgress?: (p: UploadProgress) => void;
  signal?: AbortSignal;
  /** 사진 압축 (기본 true) */
  compress?: boolean;
  /** 끊겼을 때 새로 시도할 횟수 (기본 2) */
  retries?: number;
}

export interface UploadResult {
  token: string;
  file: UploadedFile;
}

export class UploadError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status = 0,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "UploadError";
  }
}

// ---------------- 사진 압축 ----------------

export interface PreparedFile {
  blob: Blob;
  name: string;
  mime: string;
  width?: number;
  height?: number;
}

const COMPRESSIBLE = new Set(["image/jpeg", "image/png", "image/webp", "image/bmp", "image/heic", "image/heif", "image/avif"]);

function replaceExt(name: string, ext: string): string {
  const i = name.lastIndexOf(".");
  return (i > 0 ? name.slice(0, i) : name) + "." + ext;
}

interface Decoded {
  source: CanvasImageSource;
  width: number;
  height: number;
  close(): void;
}

/** EXIF 회전을 반영해 디코드. createImageBitmap(imageOrientation) 우선, 안 되면 <img>(최신 브라우저는 EXIF 를 기본 반영). */
async function decodeImage(file: Blob): Promise<Decoded> {
  if (typeof createImageBitmap === "function") {
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
      return { source: bmp, width: bmp.width, height: bmp.height, close: () => bmp.close() };
    } catch {
      /* 아래 <img> 로 */
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const im = new Image();
      im.decoding = "async";
      im.onload = () => resolve(im);
      im.onerror = () => reject(new UploadError("이 사진 형식을 열 수 없어요. JPG 또는 PNG로 바꿔 주세요.", "image_decode"));
      im.src = url;
    });
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, close: () => URL.revokeObjectURL(url) };
  } catch (e) {
    URL.revokeObjectURL(url);
    throw e;
  }
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

/**
 * 사진을 긴 변 MAX_EDGE 이하 WebP(지원 안 하면 JPEG)로 줄인다.
 * GIF(움직임 보존)·SVG·작은 사진은 원본 그대로. 사진이 아니면 그대로.
 * 결과가 원본보다 크고 원본이 이미 충분히 작으면 원본을 쓴다.
 */
export async function compressImage(file: File): Promise<PreparedFile> {
  const mime = file.type || "application/octet-stream";
  const original: PreparedFile = { blob: file, name: file.name, mime };
  if (!COMPRESSIBLE.has(mime)) return original;
  if (file.size > MAX_SOURCE_IMAGE_BYTES) throw new UploadError("원본 사진은 40MB 이하로 골라 주세요.", "image_too_large");

  let img: Decoded;
  try {
    img = await decodeImage(file);
  } catch (e) {
    // HEIC 등 브라우저가 못 여는 사진은 파일로 그대로 올린다
    if (mime === "image/heic" || mime === "image/heif") return original;
    throw e;
  }
  try {
    const { width: w0, height: h0 } = img;
    if (!w0 || !h0) return original;
    const longEdge = Math.max(w0, h0);
    if (longEdge <= MAX_EDGE && file.size <= SMALL_IMAGE_BYTES && mime !== "image/heic" && mime !== "image/heif") {
      return { ...original, width: w0, height: h0 };
    }
    const scale = Math.min(1, MAX_EDGE / longEdge);
    const w = Math.max(1, Math.round(w0 * scale));
    const h = Math.max(1, Math.round(h0 * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return { ...original, width: w0, height: h0 };
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";

    // WebP 는 투명도를 지킨다. 지원 안 하는 브라우저(구형 Safari)는 흰 바탕 JPEG.
    ctx.drawImage(img.source, 0, 0, w, h);
    let out = await canvasToBlob(canvas, "image/webp", WEBP_QUALITY);
    let outMime = "image/webp";
    let ext = "webp";
    if (!out || out.type !== "image/webp") {
      ctx.globalCompositeOperation = "destination-over";
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, w, h);
      ctx.globalCompositeOperation = "source-over";
      out = await canvasToBlob(canvas, "image/jpeg", JPEG_QUALITY);
      outMime = "image/jpeg";
      ext = "jpg";
    }
    if (!out) return { ...original, width: w0, height: h0 };
    if (out.size >= file.size && scale === 1 && mime !== "image/heic" && mime !== "image/heif") {
      return { ...original, width: w0, height: h0 };
    }
    return { blob: out, name: replaceExt(file.name || "사진", ext), mime: outMime, width: w, height: h };
  } finally {
    img.close();
  }
}

// ---------------- 전송 ----------------

let directBlocked = false;
const DIRECT_BLOCKED_KEY = "nb_upload_direct_blocked";
function isDirectBlocked(): boolean {
  if (directBlocked) return true;
  try {
    return sessionStorage.getItem(DIRECT_BLOCKED_KEY) === "1";
  } catch {
    return false;
  }
}
function markDirectBlocked(): void {
  directBlocked = true;
  try {
    sessionStorage.setItem(DIRECT_BLOCKED_KEY, "1");
  } catch {
    /* 무시 */
  }
}

async function apiJson<T>(url: string, body: unknown, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json", ...authHeader() },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if (signal?.aborted) throw abortError();
    throw new UploadError("인터넷 연결을 확인하고 다시 시도해 주세요.", "network", 0, true);
  }
  const j = (await res.json().catch(() => null)) as ({ error?: { code?: string; message?: string } } & T) | null;
  if (!res.ok) {
    const code = j?.error?.code ?? "http_" + res.status;
    const msg = j?.error?.message ?? "파일을 올리지 못했어요. 다시 시도해 주세요.";
    throw new UploadError(msg, code, res.status, res.status >= 500 || res.status === 409 || res.status === 410);
  }
  return j as T;
}

/** 학생 토큰 등 추가 인증 헤더를 붙이는 훅 (학생 화면이 설정). 교사는 쿠키라 필요 없음. */
let authHeader: () => Record<string, string> = () => ({});
export function setUploadAuthHeader(fn: () => Record<string, string>): void {
  authHeader = fn;
}

function abortError(): DOMException {
  return new DOMException("업로드를 취소했어요.", "AbortError");
}

interface PutResult {
  status: number;
  body: string;
  /** 서버로 보낸 바이트가 있었는가 */
  sentAny: boolean;
}

/** XHR PUT (fetch 는 업로드 진행률을 못 줘서 XHR 사용). 네트워크/CORS 실패는 status 0. */
function xhrPut(
  url: string,
  headers: Record<string, string>,
  blob: Blob,
  onProgress: (loaded: number) => void,
  signal?: AbortSignal,
): Promise<PutResult> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const xhr = new XMLHttpRequest();
    let sentAny = false;
    xhr.open("PUT", url, true);
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => {
      if (e.loaded > 0) sentAny = true;
      onProgress(e.loaded);
    };
    const onAbort = () => xhr.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    const done = (r: PutResult) => {
      signal?.removeEventListener("abort", onAbort);
      resolve(r);
    };
    xhr.onload = () => done({ status: xhr.status, body: xhr.responseText, sentAny: true });
    xhr.onerror = () => done({ status: 0, body: "", sentAny });
    xhr.ontimeout = () => done({ status: 0, body: "", sentAny: true });
    xhr.onabort = () => {
      signal?.removeEventListener("abort", onAbort);
      reject(abortError());
    };
    xhr.send(blob);
  });
}

function fileIdFrom(body: string, key: "id" | "driveFileId"): string | undefined {
  try {
    const j = JSON.parse(body) as Record<string, unknown>;
    const v = j[key];
    return typeof v === "string" ? v : undefined;
  } catch {
    return undefined;
  }
}

function errorMessageFrom(body: string): { code?: string; message?: string } {
  try {
    return (JSON.parse(body) as { error?: { code?: string; message?: string } }).error ?? {};
  } catch {
    return {};
  }
}

async function uploadOnce(code: string, prepared: PreparedFile, opts: UploadOptions): Promise<UploadResult> {
  const enc = encodeURIComponent(code);
  const total = prepared.blob.size;
  const report = (loaded: number) =>
    opts.onProgress?.({ phase: "upload", fraction: total ? Math.min(1, loaded / total) : 1, loaded, total });

  const req: CreateUploadRequest = { name: prepared.name, size: total, mime: prepared.mime };
  if (prepared.width && prepared.height) Object.assign(req, { width: prepared.width, height: prepared.height });
  const session = await apiJson<CreateUploadResponse>(`/api/boards/${enc}/uploads`, req, opts.signal);
  report(0);

  const sessionUrl = session.mode === "direct" ? session.uploadUrl : session.fallback?.headers["x-upload-session"];
  let driveFileId: string | undefined;
  let usedProxy = session.mode === "proxy";

  if (session.mode === "direct" && !isDirectBlocked()) {
    const r = await xhrPut(session.uploadUrl, session.headers, prepared.blob, report, opts.signal);
    if (r.status === 200 || r.status === 201) {
      driveFileId = fileIdFrom(r.body, "id");
    } else if (r.status === 0 && !r.sentAny && session.fallback) {
      // CORS(사전 요청) 거부나 Google 차단: 한 바이트도 안 갔으니 같은 세션을 프록시로
      markDirectBlocked();
      usedProxy = true;
    } else if (r.status === 0) {
      // 바이트는 갔지만 응답을 못 읽음(응답에 CORS 헤더가 없거나 연결 끊김).
      // 서버가 세션 상태로 직접 확인하게 해 본다. 아직 안 끝났으면(409) 다음부터는 프록시를 쓴다.
      try {
        opts.onProgress?.({ phase: "verify", fraction: 1, loaded: total, total });
        return await apiJson<CompleteUploadResponse>(
          `/api/boards/${enc}/uploads/${encodeURIComponent(session.uploadId)}/complete`,
          { sessionUrl },
          opts.signal,
        );
      } catch (e) {
        if (e instanceof UploadError && e.status === 409) markDirectBlocked();
        throw e instanceof UploadError ? new UploadError("업로드 중 연결이 끊겼어요.", "network", 0, true) : e;
      }
    } else {
      // Drive 가 세션을 거부(4xx)하거나 5xx: 새 세션으로 다시
      throw new UploadError("파일을 올리지 못했어요. 다시 시도해 주세요.", "drive_" + r.status, r.status, true);
    }
  } else {
    usedProxy = true;
  }

  if (usedProxy) {
    const fb = session.mode === "proxy" ? { uploadUrl: session.uploadUrl, headers: session.headers } : session.fallback;
    if (!fb) throw new UploadError("파일을 올리지 못했어요. 다시 시도해 주세요.", "no_fallback");
    const r = await xhrPut(fb.uploadUrl, fb.headers, prepared.blob, report, opts.signal);
    if (r.status === 200) {
      driveFileId = fileIdFrom(r.body, "driveFileId");
    } else {
      const e = errorMessageFrom(r.body);
      throw new UploadError(
        e.message ?? (r.status === 0 ? "업로드 중 연결이 끊겼어요." : "파일을 올리지 못했어요. 다시 시도해 주세요."),
        e.code ?? (r.status === 0 ? "network" : "proxy_" + r.status),
        r.status,
        r.status === 0 || r.status >= 500 || r.status === 409 || r.status === 410,
      );
    }
  }

  opts.onProgress?.({ phase: "verify", fraction: 1, loaded: total, total });
  return apiJson<CompleteUploadResponse>(
    `/api/boards/${enc}/uploads/${encodeURIComponent(session.uploadId)}/complete`,
    { sessionUrl, driveFileId },
    opts.signal,
  );
}

/**
 * 파일 하나를 보드에 올린다. 성공하면 업로드 확인 토큰과 파일 정보.
 * @throws UploadError (한국어 message), 취소하면 DOMException("AbortError")
 */
export async function uploadAttachment(code: string, file: File, opts: UploadOptions = {}): Promise<UploadResult> {
  if (!file || !Number.isFinite(file.size) || file.size < 1) throw new UploadError("내용이 있는 파일을 골라 주세요.", "empty");
  opts.onProgress?.({ phase: "compress", fraction: 0, loaded: 0, total: file.size });
  const prepared = opts.compress === false ? { blob: file, name: file.name, mime: file.type || "application/octet-stream" } : await compressImage(file);
  if (opts.signal?.aborted) throw abortError();

  const retries = opts.retries ?? 2;
  for (let attempt = 0; ; attempt++) {
    try {
      return await uploadOnce(code, prepared, opts);
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") throw e;
      if (!(e instanceof UploadError) || !e.retryable || attempt >= retries) throw e;
      await new Promise((r) => setTimeout(r, 800 * 2 ** attempt));
      if (opts.signal?.aborted) throw abortError();
    }
  }
}
