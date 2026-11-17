/**
 * 보드 접속자 인증 (DESIGN §10). 교사 쿠키 또는 학생 토큰(보드 범위).
 *
 * 학생 토큰: purpose "student", HMAC 서명, 30일.
 *   명단: { b: boardId, r: "s:{학생id}", k: "roster", sid, pv, np? }  — pv(PIN 버전)가 바뀌면(PIN 초기화·바꾸기) 무효.
 *         np = 1 이면 PIN 없이(학번만) 들어온 입장 → 보드가 PIN 을 묻게 바뀌면 무효
 *   자유: { b: boardId, r: "f:{기기 해시}", k: "free", n: 닉네임 }
 * 토큰 위치: `Authorization: Bearer …` 또는 (웹소켓처럼 헤더를 못 붙일 때) 쿼리 `?st=…`.
 * 학생 토큰이 있으면 그것을 쓰고, 없을 때만 교사 쿠키를 본다.
 */
import type { Env } from "../env";
import { getSigningSecret, getTeacher, signToken, verifyToken, base64UrlEncode } from "../auth";
import { getRegistry } from "../stubs";
import type { BoardRecord, StudentAuthInfo } from "../registry";
import { normalizeBoardCode, isValidBoardCode, type ErrorCode } from "../../shared/protocol";
import { TEACHER_NAME, TEACHER_REF } from "./view";

export interface BoardActor {
  role: "teacher" | "student";
  ref: string;
  name: string;
  boardId: string;
  code: string;
  /** 명단 학생이 PIN 없이(학번만) 들어옴. 보드가 PIN 을 묻게 바뀌면 이 연결은 끊긴다 */
  noPin?: true;
}

export const STUDENT_TOKEN_PURPOSE = "student";
export const STUDENT_TOKEN_TTL = 30 * 24 * 60 * 60;
export type StudentTokenClaims =
  | { b: string; r: string; k: "roster"; sid: string; pv: number; np?: 1 }
  | { b: string; r: string; k: "free"; n: string };

export async function issueStudentToken(env: Env, claims: StudentTokenClaims): Promise<string> {
  return signToken(await getSigningSecret(env), STUDENT_TOKEN_PURPOSE, claims, STUDENT_TOKEN_TTL);
}

/** 자유 입장 ref: 보드 id + 기기 토큰의 SHA-256 (기기 토큰 자체는 서버에 남기지 않는다) */
export async function freeRef(boardId: string, deviceToken: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${boardId}:${deviceToken}`));
  return "f:" + base64UrlEncode(d).slice(0, 22);
}

export function studentTokenFrom(request: Request): string | null {
  const auth = request.headers.get("authorization");
  if (auth && /^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, "").trim() || null;
  const q = new URL(request.url).searchParams.get("st");
  return q || null;
}

export type ActorResolution =
  | { ok: true; actor: BoardActor; board: BoardRecord; student: StudentAuthInfo | null; claims: StudentTokenClaims | null }
  | { ok: false; code: ErrorCode; status: number; message: string };

const no = (code: ErrorCode, status: number, message: string): ActorResolution => ({ ok: false, code, status, message });

/** authenticateBoardActor 의 자세한 버전 (왜 안 되는지 알려 줌) */
export async function resolveBoardActor(request: Request, env: Env, rawCode: string): Promise<ActorResolution> {
  const code = normalizeBoardCode(rawCode);
  if (!isValidBoardCode(code)) return no("not_found", 404, "입장코드를 다시 확인해 주세요.");
  const token = studentTokenFrom(request);
  const registry = getRegistry(env);

  if (token) {
    const c = await verifyToken<StudentTokenClaims>(await getSigningSecret(env), STUDENT_TOKEN_PURPOSE, token);
    if (!c || typeof c.b !== "string" || typeof c.r !== "string") return no("unauthorized", 401, "다시 입장해 주세요.");
    const res = await registry.resolveBoardForActor(code, c.k === "roster" ? c.sid : null);
    // 보드 범위: 다른 보드의 토큰은 거부. 없는 코드도 같은 답을 준다
    // (아무 보드 토큰으로 코드가 있는지 없는지 알아내지 못하게. 없는 코드는 공개 조회에서 404·횟수 제한)
    if (!res || res.board.id !== c.b) return no("unauthorized", 401, "이 보드에 다시 입장해 주세요.");
    const board = res.board;
    if (board.archived) return no("archived", 403, "보관된 보드예요. 선생님께 여쭤 보세요.");
    if (c.k !== board.entryMode) return no("unauthorized", 401, "입장 방식이 바뀌었어요. 다시 입장해 주세요.");
    if (c.k === "roster") {
      const s = res.student;
      if (!s || s.ref !== c.r || s.pinVersion !== c.pv) return no("unauthorized", 401, "다시 입장해 주세요.");
      const noPin = c.np === 1;
      // PIN 없이 들어온 입장은 PIN 을 묻는 보드에서 쓸 수 없다 (보드 설정이 바뀌었거나 위조 시도)
      if (noPin && board.requirePin) return no("unauthorized", 401, "이제 PIN으로 들어와요. 다시 입장해 주세요.");
      const actor: BoardActor = { role: "student", ref: s.ref, name: s.name, boardId: board.id, code: board.code };
      if (noPin) actor.noPin = true;
      const claims: StudentTokenClaims = { b: c.b, r: c.r, k: "roster", sid: c.sid, pv: c.pv };
      if (noPin) claims.np = 1;
      return { ok: true, actor, board, student: s, claims };
    }
    if (c.k === "free" && c.r.startsWith("f:")) {
      const name = typeof c.n === "string" ? c.n : "학생";
      return {
        ok: true,
        actor: { role: "student", ref: c.r, name, boardId: board.id, code: board.code },
        board,
        student: null,
        claims: { b: c.b, r: c.r, k: "free", n: name },
      };
    }
    return no("unauthorized", 401, "다시 입장해 주세요.");
  }

  const teacher = await getTeacher(request, env);
  if (!teacher) return no("unauthorized", 401, "입장이 필요해요.");
  const res = await registry.resolveBoardForActor(code, null);
  if (!res) return no("not_found", 404, "입장코드를 다시 확인해 주세요.");
  return {
    ok: true,
    actor: { role: "teacher", ref: TEACHER_REF, name: TEACHER_NAME, boardId: res.board.id, code: res.board.code },
    board: res.board,
    student: null,
    claims: null,
  };
}

/** DESIGN §10 계약: 교사 쿠키 또는 학생 토큰으로 보드 접속자를 확인. 아니면 null. */
export async function authenticateBoardActor(request: Request, env: Env, code: string): Promise<BoardActor | null> {
  const r = await resolveBoardActor(request, env, code);
  return r.ok ? r.actor : null;
}
