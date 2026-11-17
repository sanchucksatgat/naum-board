/** 학생 입장 REST (docs/PROTOCOL.md §8). 오류는 서버의 한국어 message 를 담은 ApiError. */
import type {
  BoardPublicInfo,
  ChangePinRequest,
  ErrorCode,
  JoinRequest,
  LoginRequest,
  LoginResponse,
  NicknameRequest,
  StudentInfo,
  StudentMeResponse,
  TokenResponse,
} from "../../src/shared/protocol";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode | "network" | string,
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function req<T>(method: string, url: string, body?: unknown, token?: string | null): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (token) headers.authorization = "Bearer " + token;
  let res: Response;
  try {
    res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: "same-origin" });
  } catch {
    throw new ApiError(0, "network", "인터넷 연결을 확인하고 다시 해 주세요.");
  }
  const j = (await res.json().catch(() => null)) as ({ error?: { code?: string; message?: string; retryAfterMs?: number } } & T) | null;
  if (!res.ok) {
    const e = j?.error;
    let retry = e?.retryAfterMs;
    if (retry === undefined) {
      const ra = Number(res.headers.get("retry-after"));
      if (Number.isFinite(ra) && ra > 0) retry = ra * 1000;
    }
    throw new ApiError(res.status, e?.code ?? "http_" + res.status, e?.message ?? "잠시 문제가 생겼어요. 다시 해 주세요.", retry);
  }
  return j as T;
}

const base = (code: string) => `/api/boards/${encodeURIComponent(code)}`;

export const studentApi = {
  info: (code: string) => req<BoardPublicInfo>("GET", base(code)),
  login: (code: string, body: LoginRequest) => req<LoginResponse>("POST", base(code) + "/login", body),
  /** 나만의 PIN 으로 바꾸기 → 새 토큰 (예전 토큰은 모두 무효) */
  changePin: (code: string, token: string, body: ChangePinRequest) => req<TokenResponse>("POST", base(code) + "/pin", body, token),
  join: (code: string, body: JoinRequest) => req<TokenResponse>("POST", base(code) + "/join", body),
  nickname: (code: string, token: string, body: NicknameRequest) =>
    req<{ student: StudentInfo; token?: string }>("POST", base(code) + "/nickname", body, token),
  me: (code: string, token: string) => req<StudentMeResponse>("GET", base(code) + "/me", undefined, token),
};

/** "4분 30초" 처럼 남은 시간 */
export function formatWait(ms: number): string {
  const sec = Math.max(1, Math.ceil(ms / 1000));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m && s) return `${m}분 ${s}초`;
  if (m) return `${m}분`;
  return `${s}초`;
}
