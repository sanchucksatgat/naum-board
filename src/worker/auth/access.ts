import type { Env } from "../env";
import type { GoogleAccessFailure } from "../registry";
import { ACCESS_TOKEN_SKEW_MS } from "../registry";
import { getRegistry } from "../stubs";

export type { GoogleAccessFailure } from "../registry";

/** getGoogleAccessToken 실패. reason 으로 분기: reconnect_required 면 교사에게 "다시 연결" 안내. */
export class GoogleAccessError extends Error {
  constructor(readonly reason: GoogleAccessFailure) {
    super(MESSAGES[reason]);
    this.name = "GoogleAccessError";
  }
  get needsReconnect(): boolean {
    return this.reason === "reconnect_required";
  }
}

const MESSAGES: Record<GoogleAccessFailure, string> = {
  not_configured: "Google 연결 설정(클라이언트 ID/시크릿)이 필요해요.",
  not_connected: "아직 교사 계정이 연결되지 않았어요.",
  reconnect_required: "Google 드라이브 연결이 끊겼어요. 다시 로그인해 주세요.",
  google_error: "Google 서버와 잠시 연결되지 않아요. 잠시 후 다시 시도해 주세요.",
};

let isolateCache: { accessToken: string; expiresAt: number } | null = null;

/**
 * 교사 Google 계정의 접근 토큰 (Drive API 호출용).
 * isolate 메모리 → Registry DO 메모리 → refresh token 갱신 순으로 찾고, 만료 1분 전까지 재사용.
 * @throws GoogleAccessError
 */
export async function getGoogleAccessToken(env: Env): Promise<string> {
  const c = isolateCache;
  if (c && c.expiresAt - ACCESS_TOKEN_SKEW_MS > Date.now()) return c.accessToken;
  const r = await getRegistry(env).getAccessToken();
  if (!r.ok) {
    isolateCache = null;
    throw new GoogleAccessError(r.reason);
  }
  isolateCache = { accessToken: r.accessToken, expiresAt: r.expiresAt };
  return r.accessToken;
}

/** Drive API 가 401(토큰 무효)을 주면 호출한 뒤 getGoogleAccessToken 으로 한 번 재시도할 것. */
export async function invalidateGoogleAccessToken(env: Env): Promise<void> {
  isolateCache = null;
  await getRegistry(env).invalidateAccessToken();
}

/** 소유자 변경 등으로 isolate 캐시만 비울 때 */
export function forgetIsolateAccessToken(): void {
  isolateCache = null;
}
