/**
 * 학생 입장 REST + 보드 웹소켓 경로 (DESIGN §4, §6). 태스크2.
 *   GET  /api/boards/:code            공개 정보
 *   POST /api/boards/:code/login      명단: 학번 + PIN
 *   POST /api/boards/:code/pin        처음 입장: 나만의 PIN 정하기
 *   POST /api/boards/:code/join       자유: 닉네임 + 기기 토큰
 *   POST /api/boards/:code/nickname   닉네임 바꾸기 (학생 토큰)
 *   GET  /api/boards/:code/me         학생 토큰 확인
 *   GET  /api/boards/:code/ws         웹소켓 (학생 토큰 ?st= 또는 Bearer, 또는 교사 쿠키)
 */
import { Hono } from "hono";
import type { Env } from "../env";
import { HttpError } from "../http";
import { getBoardStub, getRegistry } from "../stubs";
import type { StudentAuthInfo } from "../registry";
import {
  isValidBoardCode, LIMITS, normalizeBoardCode,
  type BoardPublicInfo, type LoginResponse, type StudentInfo, type StudentMeResponse, type TokenResponse,
} from "../../shared/protocol";
import { assertSameOrigin, readJson, syncClassRoster, unwrap } from "../registry/sync";
import { freeRef, issuePinSetupToken, issueStudentToken, readPinSetupToken, resolveBoardActor, studentTokenFrom } from "./actor";
import { ACTOR_HEADER, type ConnectHeader } from "./index";
import { line } from "./validate";
import { ValidationError } from "./validate";

export const boardRoutes = new Hono<{ Bindings: Env }>();

const noStore = { "cache-control": "no-store" };

function codeParam(raw: string): string {
  const code = normalizeBoardCode(raw);
  if (!isValidBoardCode(code)) throw new HttpError(404, "not_found", "입장코드를 다시 확인해 주세요.");
  return code;
}

function clientIp(request: Request): string {
  return request.headers.get("cf-connecting-ip") ?? request.headers.get("x-real-ip") ?? "unknown";
}

export function rosterStudentInfo(s: StudentAuthInfo): StudentInfo {
  const info: StudentInfo = { ref: s.ref, name: s.nickname || s.name, realName: s.name, number: s.number, nickname: s.nickname };
  if (s.group) info.group = s.group;
  return info;
}

function freeStudentInfo(ref: string, nickname: string): StudentInfo {
  return { ref, name: nickname, nickname };
}

function nicknameValue(v: unknown, required: boolean): string {
  try {
    return line(v, LIMITS.nickname, "닉네임", required);
  } catch (e) {
    if (e instanceof ValidationError) throw new HttpError(400, "bad_request", e.message);
    throw e;
  }
}

boardRoutes.get("/api/boards/:code", async (c) => {
  const code = codeParam(c.req.param("code"));
  const b = unwrap(await getRegistry(c.env).lookupBoardByCode(code, clientIp(c.req.raw)));
  const body: BoardPublicInfo = { code: b.code, title: b.title, entryMode: b.entryMode, locked: b.locked, archived: b.archived };
  return c.json(body, 200, noStore);
});

boardRoutes.post("/api/boards/:code/login", async (c) => {
  assertSameOrigin(c.req.raw);
  const code = codeParam(c.req.param("code"));
  const body = await readJson(c);
  const r = unwrap(await getRegistry(c.env).studentLogin({ code, number: body.number, pin: body.pin, ip: clientIp(c.req.raw) }));
  const student = rosterStudentInfo(r.student);
  let res: LoginResponse;
  if (r.needsSetup) {
    res = { status: "pin_setup", setupToken: await issuePinSetupToken(c.env, { b: r.board.id, sid: r.student.id, pv: r.student.pinVersion }), student };
  } else {
    const token = await issueStudentToken(c.env, { b: r.board.id, r: r.student.ref, k: "roster", sid: r.student.id, pv: r.student.pinVersion });
    res = { status: "ok", token, student };
  }
  return c.json(res, 200, noStore);
});

boardRoutes.post("/api/boards/:code/pin", async (c) => {
  assertSameOrigin(c.req.raw);
  const code = codeParam(c.req.param("code"));
  const body = await readJson(c);
  const setup = await readPinSetupToken(c.env, body.setupToken);
  if (!setup) throw new HttpError(401, "unauthorized", "시간이 지났어요. 처음부터 다시 입장해 주세요.");
  const reg = getRegistry(c.env);
  const b = await reg.resolveBoardByCode(code);
  if (!b || b.id !== setup.b) throw new HttpError(401, "unauthorized", "처음부터 다시 입장해 주세요.");
  const r = unwrap(await reg.studentSetPin({ boardId: setup.b, studentId: setup.sid, pinVersion: setup.pv, newPin: body.newPin }));
  // PIN 버전이 올라갔으니 보드 사본도 맞춘다 (예전 토큰 연결 끊김)
  c.executionCtx.waitUntil(syncClassRoster(c.env, r.student.classId).catch((e) => console.warn("roster sync failed", e)));
  const token = await issueStudentToken(c.env, { b: r.board.id, r: r.student.ref, k: "roster", sid: r.student.id, pv: r.student.pinVersion });
  const res: TokenResponse = { token, student: rosterStudentInfo(r.student) };
  return c.json(res, 200, noStore);
});

boardRoutes.post("/api/boards/:code/join", async (c) => {
  assertSameOrigin(c.req.raw);
  const code = codeParam(c.req.param("code"));
  const body = await readJson(c);
  const nickname = nicknameValue(body.nickname, true);
  const device = body.deviceToken;
  if (typeof device !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(device)) {
    throw new HttpError(400, "bad_request", "기기 정보가 올바르지 않아요. 화면을 새로 고쳐 주세요.");
  }
  const b = unwrap(await getRegistry(c.env).lookupBoardByCode(code, clientIp(c.req.raw)));
  if (b.archived) throw new HttpError(403, "archived", "보관된 보드예요. 선생님께 여쭤 보세요.");
  if (b.entryMode !== "free") throw new HttpError(400, "wrong_entry_mode", "이 보드는 학번과 PIN으로 들어가요.");
  const ref = await freeRef(b.id, device);
  const r = unwrap(await getBoardStub(c.env, b.id).joinFree({ ref, nickname }));
  const token = await issueStudentToken(c.env, { b: b.id, r: ref, k: "free", n: r.nickname });
  const res: TokenResponse = { token, student: freeStudentInfo(ref, r.nickname) };
  return c.json(res, 200, noStore);
});

boardRoutes.post("/api/boards/:code/nickname", async (c) => {
  assertSameOrigin(c.req.raw);
  if (!studentTokenFrom(c.req.raw)) throw new HttpError(401, "unauthorized", "다시 입장해 주세요.");
  const res = await resolveBoardActor(c.req.raw, c.env, c.req.param("code"));
  if (!res.ok) throw new HttpError(res.status, res.code, res.message);
  const body = await readJson(c);
  if (res.board.locked) throw new HttpError(403, "locked", "선생님이 보드를 잠갔어요.");
  if (res.student) {
    const nickname = nicknameValue(body.nickname, false);
    const s = unwrap(await getRegistry(c.env).setStudentNickname(res.student.id, nickname));
    await syncClassRoster(c.env, s.classId);
    return c.json({ student: rosterStudentInfo(s) } satisfies StudentMeResponse, 200, noStore);
  }
  const nickname = nicknameValue(body.nickname, true);
  const r = unwrap(await getBoardStub(c.env, res.board.id).setFreeNickname(res.actor.ref, nickname));
  const token = await issueStudentToken(c.env, { b: res.board.id, r: res.actor.ref, k: "free", n: r.nickname });
  return c.json({ token, student: freeStudentInfo(res.actor.ref, r.nickname) } satisfies TokenResponse, 200, noStore);
});

boardRoutes.get("/api/boards/:code/me", async (c) => {
  if (!studentTokenFrom(c.req.raw)) throw new HttpError(401, "unauthorized", "다시 입장해 주세요.");
  const res = await resolveBoardActor(c.req.raw, c.env, c.req.param("code"));
  if (!res.ok) throw new HttpError(res.status, res.code, res.message);
  const student = res.student ? rosterStudentInfo(res.student) : freeStudentInfo(res.actor.ref, res.actor.name);
  return c.json({ student } satisfies StudentMeResponse, 200, noStore);
});

boardRoutes.get("/api/boards/:code/ws", async (c) => {
  if (c.req.header("upgrade")?.toLowerCase() !== "websocket") {
    throw new HttpError(426, "bad_request", "웹소켓 연결이 필요해요.");
  }
  const hasStudentToken = !!studentTokenFrom(c.req.raw);
  // 교사 쿠키로 붙는 연결은 다른 사이트에서 열 수 없게 (Cross-Site WebSocket Hijacking 방지)
  if (!hasStudentToken) assertSameOrigin(c.req.raw);
  const res = await resolveBoardActor(c.req.raw, c.env, c.req.param("code"));
  if (!res.ok) throw new HttpError(res.status, res.code, res.message);
  const hdr: ConnectHeader = { actor: res.actor };
  if (res.student) {
    const s = res.student;
    hdr.roster = { ref: s.ref, number: s.number, name: s.name, nickname: s.nickname, group: s.group, pinVersion: s.pinVersion };
  }
  const headers = new Headers({ upgrade: "websocket", [ACTOR_HEADER]: encodeURIComponent(JSON.stringify(hdr)) });
  for (const h of ["sec-websocket-key", "sec-websocket-version", "sec-websocket-protocol", "sec-websocket-extensions"]) {
    const v = c.req.header(h);
    if (v) headers.set(h, v);
  }
  return getBoardStub(c.env, res.board.id).fetch(new Request("https://board.internal/ws", { headers }));
});
