import type { Registry } from "./registry";
import type { Board } from "./board";

/**
 * Worker 바인딩·설정값. 이름은 docs/DESIGN.md §3 과 wrangler.jsonc 가 기준.
 * 빈 문자열은 "설정 안 됨"으로 취급한다 (readVar 사용).
 */
export interface Env {
  REGISTRY: DurableObjectNamespace<Registry>;
  BOARD: DurableObjectNamespace<Board>;
  ASSETS: Fetcher;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  SESSION_SECRET?: string;
  OWNER_EMAIL?: string;
}

/** 변수/시크릿 읽기: 앞뒤 공백 제거, 빈 값은 undefined. */
export function readVar(env: Env, name: "GOOGLE_CLIENT_ID" | "GOOGLE_CLIENT_SECRET" | "SESSION_SECRET" | "OWNER_EMAIL"): string | undefined {
  const v = env[name];
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t === "" ? undefined : t;
}
