import { readVar, type Env } from "../env";
import { getRegistry } from "../stubs";

/** SESSION_SECRET 이 이보다 짧으면 무시하고 Registry 생성 키를 쓴다. */
export const MIN_SECRET_LENGTH = 32;

let cachedGenerated: Promise<string> | null = null;

/**
 * 모든 HMAC 토큰(세션·학생·파일 보기)의 서명 키.
 * SESSION_SECRET 시크릿이 있으면 그것을, 없으면 Registry DO가 처음 한 번 생성해 보관한 키를 쓴다.
 * (Registry 키는 isolate 메모리에 캐시 — 바뀌지 않으므로 안전)
 */
export function getSigningSecret(env: Env): Promise<string> {
  const configured = readVar(env, "SESSION_SECRET");
  if (configured && configured.length >= MIN_SECRET_LENGTH) return Promise.resolve(configured);
  if (!cachedGenerated) {
    cachedGenerated = getRegistry(env)
      .getOrCreateSessionSecret()
      .catch((e: unknown) => {
        cachedGenerated = null;
        throw e;
      });
  }
  return cachedGenerated;
}

/** 테스트 전용: isolate 캐시 비우기 */
export function resetSigningSecretCache(): void {
  cachedGenerated = null;
}
