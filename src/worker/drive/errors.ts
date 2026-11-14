import { HttpError } from "../http";

/**
 * Drive 호출 실패의 종류. 화면에는 message(한국어)를 그대로 보여 줘도 된다.
 * - reconnect: 교사가 Google 을 다시 연결해야 함 (refresh token 만료·취소, drive.file 권한 없음)
 * - storage_full: 교사 드라이브 저장 공간이 가득 참
 * - not_found: 파일·폴더가 없음 (지워졌거나 휴지통을 비움)
 * - rate_limited: Google 이 잠시 요청을 막음 (재시도 후에도)
 * - unavailable: Google 서버 일시 오류·네트워크 오류
 * - not_configured: 설치(OAuth 클라이언트)·교사 연결이 아직 안 됨
 * - api_disabled: 교사의 Google Cloud 프로젝트에서 Google Drive API 를 켜지 않음 (403 accessNotConfigured)
 * - forbidden: 그 밖의 권한 문제
 * - bad_request: 요청이 잘못됨 (코드 버그 가능성)
 */
export type DriveErrorCode =
  | "reconnect"
  | "storage_full"
  | "not_found"
  | "rate_limited"
  | "unavailable"
  | "not_configured"
  | "api_disabled"
  | "forbidden"
  | "bad_request";

const MESSAGES: Record<DriveErrorCode, string> = {
  reconnect: "Google 드라이브 연결이 끊겼어요. 선생님이 다시 로그인해 주세요.",
  storage_full: "선생님 Google 드라이브 저장 공간이 가득 찼어요. 드라이브를 정리한 뒤 다시 시도해 주세요.",
  not_found: "드라이브에서 파일을 찾을 수 없어요. 지워졌을 수 있어요.",
  rate_limited: "Google 드라이브가 바빠요. 잠시 후 다시 시도해 주세요.",
  unavailable: "Google 드라이브와 잠시 연결되지 않아요. 잠시 후 다시 시도해 주세요.",
  not_configured: "아직 선생님 Google 계정이 연결되지 않았어요.",
  api_disabled:
    "선생님의 Google Cloud 프로젝트에서 Google Drive API가 꺼져 있어요. 설치 안내(내 주소/setup#help-api)의 ‘Drive API 켜기’를 따라 켜 주세요.",
  forbidden: "드라이브 파일에 접근할 권한이 없어요.",
  bad_request: "드라이브 요청을 처리하지 못했어요. 다시 시도해 주세요.",
};

const HTTP_STATUS: Record<DriveErrorCode, number> = {
  reconnect: 503,
  storage_full: 507,
  not_found: 404,
  rate_limited: 503,
  unavailable: 503,
  not_configured: 503,
  api_disabled: 503,
  forbidden: 403,
  bad_request: 502,
};

export class DriveError extends Error {
  constructor(
    readonly code: DriveErrorCode,
    /** Google 이 준 HTTP 상태 (없으면 0) */
    readonly status = 0,
    /** Google 오류 reason (예: storageQuotaExceeded) */
    readonly reason?: string,
  ) {
    super(MESSAGES[code]);
    this.name = "DriveError";
  }

  get needsReconnect(): boolean {
    return this.code === "reconnect";
  }

  toHttpError(): HttpError {
    return new HttpError(HTTP_STATUS[this.code], `drive_${this.code}`, this.message);
  }
}

/** Drive 오류를 라우트에서 던질 HttpError 로 바꾼다 (그 밖의 오류는 그대로). */
export function asHttpError(e: unknown): unknown {
  return e instanceof DriveError ? e.toHttpError() : e;
}
