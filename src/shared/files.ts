/**
 * 업로드·첨부 파일 공용 타입 (서버·프런트 공용). 태스크3 소유, 태스크2가 import.
 * 계약: docs/DESIGN.md §7, §10.
 */

/** 첨부 종류 */
export type AttachmentKind = "image" | "file";

/**
 * 업로드 확인 토큰(purpose "upload")의 payload.
 * Board DO 는 post.save 에서 이 토큰을 verifyToken 으로 검증하고 boardId·by(actor ref) 일치를 확인한 뒤 attachments 에 저장한다.
 */
export interface UploadedFile {
  boardId: string;
  /** 올린 actor 의 ref */
  by: string;
  driveFileId: string;
  name: string;
  mime: string;
  size: number;
  kind: AttachmentKind;
  width?: number;
  height?: number;
}

/** 서명 토큰 용도 문자열 (verifyToken 의 purpose) */
export const UPLOAD_TOKEN_PURPOSE = "upload";
export const FILE_VIEW_TOKEN_PURPOSE = "file";
/** 업로드 확인 토큰 유효 기간(초): 글 저장까지 넉넉히 */
export const UPLOAD_TOKEN_TTL_SECONDS = 60 * 60;

/** 파일 보기 토큰 payload (purpose "file", 12시간) */
export interface FileViewTokenPayload {
  boardId: string;
}

/** 이름 최대 길이(문자) */
export const MAX_FILE_NAME_LENGTH = 200;

/** POST /api/boards/:code/uploads 요청 */
export interface CreateUploadRequest {
  name: string;
  /** 바이트 */
  size: number;
  mime: string;
  /** 이미지일 때 압축 후 크기(선택) */
  width?: number;
  height?: number;
}

/**
 * POST /api/boards/:code/uploads 응답.
 * - uploadUrl 로 `method` + `headers` 를 붙여 파일 바이트 전체를 보낸다.
 *   direct: Google Drive resumable 세션 주소(이 파일 하나 전용, 접근 토큰 없음)
 *   proxy:  Worker 프록시 주소(같은 출처)
 * - direct 가 네트워크/CORS 로 실패하면 fallback 으로 같은 바이트를 보낸다.
 */
export interface CreateUploadResponse {
  uploadId: string;
  uploadUrl: string;
  method: "PUT";
  headers: Record<string, string>;
  mode: "direct" | "proxy";
  /** direct 가 실패했을 때 쓸 Worker 프록시 */
  fallback?: { uploadUrl: string; method: "PUT"; headers: Record<string, string> };
}

/** POST /api/boards/:code/uploads/:uploadId/complete 요청 */
export interface CompleteUploadRequest {
  /** Drive 업로드 응답의 id (direct 업로드일 때). 프록시면 생략 가능 */
  driveFileId?: string;
}

/** POST /api/boards/:code/uploads/:uploadId/complete 응답 */
export interface CompleteUploadResponse {
  /** 업로드 확인 토큰 (post.save 에 넣는다) */
  token: string;
  file: UploadedFile;
}

/** POST /api/boards/:code/export 응답 */
export interface ExportResponse {
  url: string;
}

export type BackupStatus = "ok" | "pending" | "error" | "never";

/** GET /api/boards/:code/drive 응답 */
export interface BoardDriveResponse {
  folderUrl: string | null;
  backup: { status: BackupStatus; lastAt: number | null; error?: string };
}

/** 브라우저에서 바로 보여 줘도 안전한 MIME (그 외는 내려받기로 처리) */
export const INLINE_SAFE_MIME = new Set<string>([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/bmp",
  "application/pdf",
  "audio/mpeg",
  "audio/mp4",
  "audio/ogg",
  "audio/wav",
  "audio/webm",
  "audio/aac",
  "video/mp4",
  "video/webm",
  "video/ogg",
  "video/quicktime",
]);

/** 이미지로 취급(카드에 미리보기)할 MIME */
export const IMAGE_MIME = new Set<string>(["image/jpeg", "image/png", "image/gif", "image/webp", "image/avif", "image/bmp"]);
