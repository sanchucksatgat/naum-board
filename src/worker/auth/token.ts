/**
 * HMAC-SHA256 서명 토큰. 세션 쿠키, OAuth state, 학생 토큰, 파일 보기 토큰에 공용.
 *
 * 형식: base64url(JSON 클레임) + "." + base64url(HMAC)
 * 클레임: { p: 용도, iat, exp, ...payload }
 * 용도(purpose)가 서명 안에 들어가므로 한 용도의 토큰을 다른 용도로 쓸 수 없다.
 * 암호화가 아니라 서명이다: 내용은 누구나 읽을 수 있으니 비밀 값을 넣지 말 것.
 */

export interface TokenClaims {
  /** 용도 (예: "session", "student", "file") */
  p: string;
  /** 발급 시각 (초) */
  iat: number;
  /** 만료 시각 (초) */
  exp: number;
}

const enc = new TextEncoder();
const dec = new TextDecoder();
const keyCache = new Map<string, Promise<CryptoKey>>();

function hmacKey(secret: string): Promise<CryptoKey> {
  let k = keyCache.get(secret);
  if (!k) {
    k = crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
    if (keyCache.size > 8) keyCache.clear();
    keyCache.set(secret, k);
  }
  return k;
}

export function base64UrlEncode(data: ArrayBuffer | Uint8Array): string {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** 암호학적으로 안전한 무작위 문자열 (base64url). */
export function randomToken(bytes = 32): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(bytes)));
}

const nowSec = () => Math.floor(Date.now() / 1000);

/**
 * 토큰 서명.
 * @param secret 서명 키 (보통 `await getSigningSecret(env)`)
 * @param purpose 용도 문자열. 검증할 때 같은 값을 줘야 통과.
 * @param payload 담을 값. 키 p/iat/exp 는 예약.
 * @param ttlSeconds 유효 기간(초)
 */
export async function signToken<T extends object>(secret: string, purpose: string, payload: T, ttlSeconds: number): Promise<string> {
  const iat = nowSec();
  const claims = { ...payload, p: purpose, iat, exp: iat + Math.max(1, Math.floor(ttlSeconds)) };
  const body = base64UrlEncode(enc.encode(JSON.stringify(claims)));
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(body));
  return `${body}.${base64UrlEncode(sig)}`;
}

/**
 * 토큰 검증. 서명·용도·만료가 모두 맞으면 클레임, 아니면 null (예외를 던지지 않음).
 */
export async function verifyToken<T extends object = Record<string, unknown>>(
  secret: string,
  purpose: string,
  token: string | null | undefined,
): Promise<(T & TokenClaims) | null> {
  if (!token || token.length > 4096) return null;
  const dot = token.indexOf(".");
  if (dot <= 0 || dot !== token.lastIndexOf(".")) return null;
  const body = token.slice(0, dot);
  let sig: Uint8Array;
  try {
    sig = base64UrlDecode(token.slice(dot + 1));
  } catch {
    return null;
  }
  // crypto.subtle.verify 는 상수 시간 비교.
  const ok = await crypto.subtle.verify("HMAC", await hmacKey(secret), sig, enc.encode(body));
  if (!ok) return null;
  let claims: unknown;
  try {
    claims = JSON.parse(dec.decode(base64UrlDecode(body)));
  } catch {
    return null;
  }
  if (!claims || typeof claims !== "object") return null;
  const c = claims as TokenClaims;
  if (c.p !== purpose || typeof c.exp !== "number" || c.exp <= nowSec()) return null;
  return claims as T & TokenClaims;
}

/** 두 문자열의 상수 시간 비교 (길이가 다르면 false). */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const x = enc.encode(a);
  const y = enc.encode(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i]! ^ y[i]!;
  return diff === 0;
}
