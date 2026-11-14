/** 서버·프런트 공용 HTTP API 타입 (태스크1 범위). 실시간 프로토콜은 protocol.ts (태스크2). */

/**
 * Drive 연결 상태.
 * - ok: 접근 토큰 발급 가능
 * - reconnect_required: refresh token 이 만료·취소됨 → 교사가 다시 로그인(연결)해야 함
 * - missing_scope: 로그인할 때 Drive 권한 체크를 해제함 → 다시 연결 필요
 * - unavailable: Google 쪽 일시 오류 등으로 확인 실패
 */
export type DriveStatus = "ok" | "reconnect_required" | "missing_scope" | "unavailable";

export interface MeResponse {
  authenticated: boolean;
  /** 설치 상태 (로그인 전에도 /setup 화면이 쓸 수 있게 공개) */
  setup: {
    googleConfigured: boolean;
    ownerClaimed: boolean;
  };
  teacher?: { email: string };
  drive?: { status: DriveStatus };
}

export interface ApiErrorBody {
  error: { code: string; message: string };
}

/**
 * GET /api/setup/drive-check (교사 로그인 필요) — 설치 점검용.
 * 선생님 드라이브에 실제로 한 번 접근해 본다. Drive API 를 켜지 않았으면 code "api_disabled".
 */
export type SetupDriveCheck =
  | { ok: true }
  | { ok: false; code: "api_disabled" | "reconnect" | "storage_full" | "unavailable" | "not_configured" | "other"; message: string };
