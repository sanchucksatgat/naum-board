/**
 * 입력 검증 도구. Board DO, Registry DO, 라우트에서 공용.
 * 검증 실패는 ValidationError 를 던지고, 경계(RPC/WS/HTTP)에서 결과 값/오류 응답으로 바꾼다.
 */
import type { ErrorCode } from "../../shared/protocol";

export class ValidationError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly status = 400,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "ValidationError";
  }
}

export const fail = (code: ErrorCode, message: string, status = 400, retryAfterMs?: number): never => {
  throw new ValidationError(code, message, status, retryAfterMs);
};

/** RPC 경계를 넘는 결과 값 (사용자 정의 예외는 RPC 로 넘어가지 않음) */
export type RpcResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: ErrorCode; message: string; status: number; retryAfterMs?: number };

export function toRpcError(e: unknown): { ok: false; code: ErrorCode; message: string; status: number; retryAfterMs?: number } {
  if (e instanceof ValidationError) {
    return { ok: false, code: e.code, message: e.message, status: e.status, ...(e.retryAfterMs !== undefined ? { retryAfterMs: e.retryAfterMs } : {}) };
  }
  throw e;
}

/** fn 을 실행해 ValidationError 는 결과 값으로, 그 밖의 예외는 그대로 던진다 */
export function rpc<T>(fn: () => T): RpcResult<T> {
  try {
    return { ok: true, value: fn() };
  } catch (e) {
    return toRpcError(e);
  }
}

export async function rpcAsync<T>(fn: () => Promise<T>): Promise<RpcResult<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (e) {
    return toRpcError(e);
  }
}

// 제어 문자(탭·줄바꿈 제외) 와 짝 없는 서로게이트 제거
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
// eslint-disable-next-line no-control-regex
const LINE_CONTROL_RE = /[\u0000-\u001F\u007F\u2028\u2029]/g;

/**
 * 여러 줄 텍스트. 문자열이 아니면 오류, 앞뒤 공백 제거, 길이 상한.
 * @param required true 면 빈 값 오류
 */
export function text(value: unknown, max: number, label: string, required = false): string {
  if (value === undefined || value === null) value = "";
  if (typeof value !== "string") fail("bad_request", `${label}은(는) 글자로 입력해 주세요.`);
  const v = (value as string).replace(/\r\n?/g, "\n").replace(CONTROL_RE, "").trim();
  if (v.length > max) fail("too_large", `${label}은(는) ${max}자까지 쓸 수 있어요.`);
  if (required && !v) fail("bad_request", `${label}을(를) 입력해 주세요.`);
  return v;
}

/** 한 줄 텍스트 (줄바꿈·제어 문자 없음) */
export function line(value: unknown, max: number, label: string, required = false): string {
  if (value === undefined || value === null) value = "";
  if (typeof value !== "string") fail("bad_request", `${label}은(는) 글자로 입력해 주세요.`);
  const v = (value as string).replace(LINE_CONTROL_RE, " ").replace(/\s+/g, " ").trim();
  if (v.length > max) fail("too_large", `${label}은(는) ${max}자까지 쓸 수 있어요.`);
  if (required && !v) fail("bad_request", `${label}을(를) 입력해 주세요.`);
  return v;
}

/** http(s) 링크만. 빈 값 허용 */
export function link(value: unknown, max: number): string {
  const v = line(value, max, "링크");
  if (!v) return "";
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return fail("bad_request", "링크는 http:// 또는 https:// 로 시작하는 주소로 넣어 주세요.");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") fail("bad_request", "링크는 http:// 또는 https:// 로 시작하는 주소로 넣어 주세요.");
  return u.toString();
}

export function bool(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") fail("bad_request", `${label} 값이 올바르지 않아요.`);
  return value as boolean;
}

export function oneOf<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) fail("bad_request", `${label} 값이 올바르지 않아요.`);
  return value as T;
}

export function intIn(value: unknown, min: number, max: number, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    fail("bad_request", `${label}은(는) ${min}~${max} 사이 정수로 넣어 주세요.`);
  }
  return value as number;
}

/** id 문자열 (서버가 만든 id 를 클라이언트가 돌려줄 때) */
export function id(value: unknown, label = "id"): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_:.-]{1,128}$/.test(value)) fail("bad_request", `${label} 값이 올바르지 않아요.`);
  return value as string;
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 학번: 숫자 1~20자리 (기존 탭보드 규칙) */
export function studentNumber(value: unknown): string {
  const v = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "";
  if (!/^\d{1,20}$/.test(v)) fail("bad_request", "학번은 숫자 1~20자리로 입력해 주세요.");
  return v;
}

export function pin(value: unknown, label = "PIN"): string {
  const v = typeof value === "number" ? String(value).padStart(4, "0") : typeof value === "string" ? value.trim() : "";
  if (!/^\d{4}$/.test(v)) fail("invalid_pin", `${label}은(는) 숫자 4자리로 입력해 주세요.`);
  return v;
}

export function nickname(value: unknown, max: number): string {
  return line(value, max, "닉네임", true);
}

/** 한국어 자연 정렬 (학번 등) */
export function compareKo(a: string, b: string): number {
  return a.localeCompare(b, "ko", { numeric: true });
}
