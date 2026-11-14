import type { MiddlewareHandler } from "hono";
import type { Env } from "../env";
import { HttpError } from "../http";
import { getRegistry } from "../stubs";
import { clearCookie, getCookie, serializeCookie } from "./cookies";
import { getSigningSecret } from "./secret";
import { signToken, verifyToken } from "./token";

export const SESSION_COOKIE = "__Host-nb_session";
export const SESSION_PURPOSE = "session";
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

/** 로그인한 교사(=소유자) */
export interface TeacherSession {
  sub: string;
  email: string;
  /** 세션 만료 (초) */
  exp: number;
}

export async function createSessionCookie(env: Env, teacher: { sub: string; email: string }): Promise<string> {
  const secret = await getSigningSecret(env);
  const token = await signToken(secret, SESSION_PURPOSE, { sub: teacher.sub, email: teacher.email }, SESSION_TTL_SECONDS);
  return serializeCookie(SESSION_COOKIE, token, { maxAge: SESSION_TTL_SECONDS });
}

export function clearSessionCookie(): string {
  return clearCookie(SESSION_COOKIE);
}

// 현재 소유자 sub 를 isolate 에 잠깐 캐시 (매 요청 Registry 왕복을 줄임). 소유권 이전은 최대 이 시간 뒤 반영.
const OWNER_CACHE_MS = 60_000;
let ownerCache: { sub: string | null; at: number } | null = null;

async function currentOwnerSub(env: Env): Promise<string | null> {
  if (ownerCache && Date.now() - ownerCache.at < OWNER_CACHE_MS) return ownerCache.sub;
  const owner = await getRegistry(env).getOwner();
  ownerCache = { sub: owner?.sub ?? null, at: Date.now() };
  return ownerCache.sub;
}

/** 로그인 직후 등 소유자가 바뀌었을 수 있을 때 호출 */
export function forgetOwnerCache(): void {
  ownerCache = null;
}

/**
 * 요청의 교사 세션을 확인한다. 없거나 잘못됐으면 null (예외 없음).
 * 학생 토큰도 받는 경로(예: 웹소켓)는 이것을 쓴다.
 */
export async function getTeacher(request: Request, env: Env): Promise<TeacherSession | null> {
  const raw = getCookie(request, SESSION_COOKIE);
  if (!raw) return null;
  const secret = await getSigningSecret(env);
  const claims = await verifyToken<{ sub: string; email: string }>(secret, SESSION_PURPOSE, raw);
  if (!claims || typeof claims.sub !== "string" || typeof claims.email !== "string") return null;
  if ((await currentOwnerSub(env)) !== claims.sub) return null;
  return { sub: claims.sub, email: claims.email, exp: claims.exp };
}

/**
 * 교사 전용 경로 보호. 세션이 없으면 HttpError(401) 를 던진다.
 * Hono 라우트에서는 throw 된 HttpError 가 401 JSON 응답이 된다.
 */
export async function requireTeacher(request: Request, env: Env): Promise<TeacherSession> {
  const t = await getTeacher(request, env);
  if (!t) throw new HttpError(401, "unauthorized", "교사 로그인이 필요해요.");
  return t;
}

/** Hono 미들웨어 버전: `app.use("/api/teacher/*", teacherOnly)` 후 `c.get("teacher")` */
export type TeacherVariables = { teacher: TeacherSession };
export const teacherOnly: MiddlewareHandler<{ Bindings: Env; Variables: TeacherVariables }> = async (c, next) => {
  c.set("teacher", await requireTeacher(c.req.raw, c.env));
  await next();
};
