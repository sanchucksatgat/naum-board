/**
 * 학생 기기 저장 (localStorage). 접근이 막힌 브라우저(사생활 보호 모드 등)에서도 죽지 않게 모두 try/catch.
 *   nb_st:{코드}      학생 토큰 (보드 하나에만 유효)
 *   nb_who:{코드}     이 기기에서 마지막으로 들어온 학생 { number, name } (명단) 또는 { nickname } (자유)
 *   nb_device         자유 입장용 기기 토큰 (무작위, 기기마다 하나)
 */
import { normalizeBoardCode } from "../../src/shared/protocol";

function get(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function set(key: string, v: string | null): void {
  try {
    if (v === null) localStorage.removeItem(key);
    else localStorage.setItem(key, v);
  } catch {
    /* 저장 못 하면 이번 화면에서만 기억 */
  }
}

const memory = new Map<string, string>();

export function getStudentToken(code: string): string | null {
  const k = "nb_st:" + normalizeBoardCode(code);
  return get(k) ?? memory.get(k) ?? null;
}

export function setStudentToken(code: string, token: string | null): void {
  const k = "nb_st:" + normalizeBoardCode(code);
  if (token === null) memory.delete(k);
  else memory.set(k, token);
  set(k, token);
}

export interface RememberedStudent {
  number?: string;
  name?: string;
  nickname?: string;
}

export function getRemembered(code: string): RememberedStudent | null {
  const raw = get("nb_who:" + normalizeBoardCode(code));
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as RememberedStudent;
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
}

export function setRemembered(code: string, who: RememberedStudent | null): void {
  set("nb_who:" + normalizeBoardCode(code), who ? JSON.stringify(who) : null);
}

function randomToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  let s = "";
  for (const b of bytes) s += "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"[b & 63];
  return s;
}

export function getDeviceToken(): string {
  let t = get("nb_device") ?? memory.get("nb_device") ?? null;
  if (!t || !/^[A-Za-z0-9_-]{16,128}$/.test(t)) {
    t = randomToken();
    memory.set("nb_device", t);
    set("nb_device", t);
  }
  return t;
}
