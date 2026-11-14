import { DurableObject } from "cloudflare:workers";
import { readVar, type Env } from "../env";
import { GoogleTokenError, refreshAccessToken } from "../auth/google";
import { randomToken } from "../auth/token";
import { applyMigrations, REGISTRY_MIGRATIONS } from "./migrations";
import { claimOwner, readOwner, toOwnerInfo, type ClaimOwnerInput, type ClaimOwnerResult, type OwnerInfo } from "./owner";
import {
  getBoardRow, getBoardRowByCode, getBoardSummary, insertBoard, listBoardSummaries, recentPosts, saveBoardStats, toRecord, updateBoardRow,
  type BoardMetaPatch, type BoardRecord, type BoardStats, type CreateBoardInput, type ResolvedBoard,
} from "./boards";
import {
  className, classExists, getClassSummary, getStudent, hashPin, insertClass, insertStudents, ipBlockedFor, listClasses, listStudents,
  pinMatches, randomPin, recordIpFailure, recordStudentFailure, toRosterMember, toTeacherStudent, validateRows, studentRef,
  type RosterMember, type StudentRow,
} from "./roster";
import { fail, line, pin as pinValue, rpc, rpcAsync, studentNumber, type RpcResult } from "../board/validate";
import { LIMITS, type BoardSummary, type ClassSummary, type RecentPost, type StudentRowInput, type TeacherStudent } from "../../shared/protocol";

export type { ClaimOwnerInput, ClaimOwnerResult, OwnerInfo } from "./owner";
export type { BoardMetaPatch, BoardRecord, BoardStats, CreateBoardInput, ResolvedBoard } from "./boards";
export type { RosterMember } from "./roster";

/** 학생 인증에 필요한 명단 학생 정보 (Worker 로 내보내는 값: PIN 관련 비밀 없음) */
export interface StudentAuthInfo {
  id: string;
  ref: string;
  classId: string;
  number: string;
  name: string;
  nickname: string;
  group: string;
  pinVersion: number;
  pinRegistered: boolean;
}

export interface LoginOutcome {
  board: BoardRecord;
  student: StudentAuthInfo;
  /** 아직 나만의 PIN 을 안 정함 (초기 PIN 으로 맞춤) */
  needsSetup: boolean;
}

function toAuthInfo(r: StudentRow): StudentAuthInfo {
  return {
    id: r.id,
    ref: studentRef(r.id),
    classId: r.class_id,
    number: r.number,
    name: r.name,
    nickname: r.nickname,
    group: r.group_name,
    pinVersion: r.pin_version,
    pinRegistered: r.pin_hash !== null,
  };
}

/** getAccessToken RPC 결과. RPC 로는 사용자 정의 예외가 그대로 넘어가지 않으므로 결과 값으로 돌려준다. */
export type AccessTokenResult =
  | { ok: true; accessToken: string; expiresAt: number }
  | { ok: false; reason: GoogleAccessFailure };

/**
 * - not_configured: GOOGLE_CLIENT_ID/SECRET 없음 또는 Google 이 클라이언트를 거부(invalid_client)
 * - not_connected: 아직 소유자가 로그인한 적 없음
 * - reconnect_required: refresh token 이 없거나 만료·취소됨 (교사가 다시 로그인해야 함)
 * - google_error: 일시 오류 (재시도 가능)
 */
export type GoogleAccessFailure = "not_configured" | "not_connected" | "reconnect_required" | "google_error";

/** 접근 토큰은 만료 이 시간 전에 미리 갱신 */
export const ACCESS_TOKEN_SKEW_MS = 60_000;

/**
 * Registry DO: 인스턴스당 하나 (getRegistry(env) 로 접근). 소유자·서명 키·Google 토큰을 보관.
 * 태스크2가 보드/반/명단 메서드를 이 클래스에 추가한다 (마이그레이션은 migrations.ts 끝에 추가).
 */
export class Registry extends DurableObject<Env> {
  protected readonly sql: SqlStorage;
  private tokenCache: { accessToken: string; expiresAt: number } | null = null;
  private refreshing: Promise<AccessTokenResult> | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => {
      applyMigrations(ctx.storage, REGISTRY_MIGRATIONS);
    });
  }

  // ---- 서명 키 ----

  /** SESSION_SECRET 이 설정되지 않았을 때 쓰는 서명 키. 처음 호출 때 만들어 영구 보관. */
  getOrCreateSessionSecret(): string {
    const row = this.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = 'session_secret'").toArray()[0];
    if (row) return row.value;
    const secret = randomToken(48);
    this.sql.exec("INSERT INTO meta (key, value) VALUES ('session_secret', ?)", secret);
    return secret;
  }

  // ---- 소유자 ----

  getOwner(): OwnerInfo | null {
    const r = readOwner(this.sql);
    return r ? toOwnerInfo(r) : null;
  }

  claimOwner(input: ClaimOwnerInput): ClaimOwnerResult {
    const result = this.ctx.storage.transactionSync(() => claimOwner(this.sql, input, Date.now()));
    if (result.ok) this.tokenCache = null;
    return result;
  }

  /** 태스크3(Drive)용: 나눔보드 최상위 폴더 id 저장/조회 */
  getDriveRootId(): string | null {
    return readOwner(this.sql)?.drive_root_id ?? null;
  }

  setDriveRootId(id: string | null): void {
    this.sql.exec("UPDATE owner SET drive_root_id = ?, updated_at = ? WHERE id = 1", id, Date.now());
  }

  // ---- Google 접근 토큰 ----

  /** 캐시된 접근 토큰을 주거나, refresh token 으로 새로 받는다. 동시 요청은 한 번의 갱신을 공유. */
  async getAccessToken(): Promise<AccessTokenResult> {
    const c = this.tokenCache;
    if (c && c.expiresAt - ACCESS_TOKEN_SKEW_MS > Date.now()) return { ok: true, ...c };
    if (!this.refreshing) {
      this.refreshing = this.refreshNow().finally(() => {
        this.refreshing = null;
      });
    }
    return this.refreshing;
  }

  /** Drive API 가 401 을 주면 호출: 캐시를 버려 다음 getAccessToken 이 새로 받게 한다. */
  invalidateAccessToken(): void {
    this.tokenCache = null;
  }

  // ───── 보드 (태스크2) ─────

  createBoard(input: CreateBoardInput): RpcResult<BoardRecord> {
    return rpc(() => this.ctx.storage.transactionSync(() => insertBoard(this.sql, input, Date.now())));
  }

  getBoardRecord(id: string): BoardRecord | null {
    const r = getBoardRow(this.sql, id);
    return r ? toRecord(r) : null;
  }

  getBoardSummary(id: string): BoardSummary | null {
    return getBoardSummary(this.sql, id);
  }

  listBoards(filter: "active" | "archived" | "all" = "all"): BoardSummary[] {
    return listBoardSummaries(this.sql, filter);
  }

  /** 보드 원본 값 변경 (Board DO 가 설정을 바꿀 때 먼저 호출) */
  updateBoardMeta(id: string, patch: BoardMetaPatch): RpcResult<BoardRecord | null> {
    return rpc(() => updateBoardRow(this.sql, id, patch, Date.now()));
  }

  deleteBoard(id: string): BoardRecord | null {
    const r = getBoardRow(this.sql, id);
    if (!r) return null;
    this.sql.exec("DELETE FROM boards WHERE id = ?", id);
    return toRecord(r);
  }

  /** DESIGN §10: 입장코드 → 보드. 없으면 null */
  resolveBoardByCode(code: string): ResolvedBoard | null {
    const r = getBoardRowByCode(this.sql, code);
    if (!r) return null;
    return { id: r.id, code: r.code, title: r.title, archived: r.archived === 1, entryMode: r.entry_mode, locked: r.locked === 1 };
  }

  /** 학생/교사 인증용: 보드 + (명단 학생이면) 그 학생이 지금도 이 보드 반에 있는지 */
  resolveBoardForActor(code: string, studentId: string | null): { board: BoardRecord; student: StudentAuthInfo | null } | null {
    const r = getBoardRowByCode(this.sql, code);
    if (!r) return null;
    const board = toRecord(r);
    if (!studentId) return { board, student: null };
    const s = getStudent(this.sql, studentId);
    return { board, student: s && s.class_id === board.classId ? toAuthInfo(s) : null };
  }

  /** Board DO 알람이 보내는 통계·최근 글 */
  updateBoardStats(id: string, stats: BoardStats): void {
    saveBoardStats(this.sql, id, stats);
  }

  setBoardDriveFolder(id: string, folderId: string | null): void {
    this.sql.exec("UPDATE boards SET drive_folder_id = ? WHERE id = ?", folderId, id);
  }

  recentPosts(limit = 12): RecentPost[] {
    return recentPosts(this.sql, limit);
  }

  // ───── 반·명단 (태스크2) ─────

  listClasses(): ClassSummary[] {
    return listClasses(this.sql);
  }

  createClass(name: unknown, students?: StudentRowInput[]): RpcResult<ClassSummary> {
    return rpc(() =>
      this.ctx.storage.transactionSync(() => {
        const now = Date.now();
        const id = insertClass(this.sql, className(name), now);
        if (students && students.length) insertStudents(this.sql, id, validateRows(students, new Set()), now);
        return getClassSummary(this.sql, id)!;
      }),
    );
  }

  renameClass(id: string, name: unknown): RpcResult<ClassSummary> {
    return rpc(() => {
      if (!classExists(this.sql, id)) fail("not_found", "반을 찾을 수 없어요.", 404);
      this.sql.exec("UPDATE classes SET name = ?, updated_at = ? WHERE id = ?", className(name), Date.now(), id);
      return getClassSummary(this.sql, id)!;
    });
  }

  deleteClass(id: string): RpcResult<null> {
    return rpc(() =>
      this.ctx.storage.transactionSync(() => {
        if (!classExists(this.sql, id)) fail("not_found", "반을 찾을 수 없어요.", 404);
        if (this.sql.exec("SELECT 1 FROM boards WHERE class_id = ?", id).toArray().length) {
          fail("class_in_use", "이 반을 쓰는 보드가 있어요. 보드에서 반 연결을 먼저 풀어 주세요.", 409);
        }
        this.sql.exec("DELETE FROM students WHERE class_id = ?", id);
        this.sql.exec("DELETE FROM classes WHERE id = ?", id);
        return null;
      }),
    );
  }

  listStudents(classId: string): TeacherStudent[] | null {
    if (!classExists(this.sql, classId)) return null;
    const now = Date.now();
    return listStudents(this.sql, classId).map((r) => toTeacherStudent(r, now));
  }

  getTeacherStudent(id: string): TeacherStudent | null {
    const r = getStudent(this.sql, id);
    return r ? toTeacherStudent(r) : null;
  }

  addStudents(classId: string, rows: StudentRowInput[]): RpcResult<TeacherStudent[]> {
    return rpc(() =>
      this.ctx.storage.transactionSync(() => {
        if (!classExists(this.sql, classId)) fail("not_found", "반을 찾을 수 없어요.", 404);
        const existing = new Set(listStudents(this.sql, classId).map((s) => s.number));
        const added = insertStudents(this.sql, classId, validateRows(rows, existing), Date.now());
        return added.map((r) => toTeacherStudent(r));
      }),
    );
  }

  updateStudent(id: string, patch: { number?: unknown; name?: unknown; group?: unknown; nickname?: unknown }): RpcResult<TeacherStudent> {
    return rpc(() => {
      const cur = getStudent(this.sql, id) ?? fail("not_found", "학생을 찾을 수 없어요.", 404);
      const number = patch.number === undefined ? cur.number : studentNumber(patch.number);
      if (number !== cur.number && this.sql.exec("SELECT 1 FROM students WHERE class_id = ? AND number = ?", cur.class_id, number).toArray().length) {
        fail("duplicate", `학번 ${number} 이(가) 이미 있어요.`, 409);
      }
      const name = patch.name === undefined ? cur.name : line(patch.name, LIMITS.studentName, "이름", true);
      const group = patch.group === undefined ? cur.group_name : line(patch.group, LIMITS.groupName, "모둠");
      const nickname = patch.nickname === undefined ? cur.nickname : line(patch.nickname, LIMITS.nickname, "닉네임");
      this.sql.exec(
        "UPDATE students SET number = ?, name = ?, group_name = ?, nickname = ?, updated_at = ? WHERE id = ?",
        number, name, group, nickname, Date.now(), id,
      );
      return toTeacherStudent(getStudent(this.sql, id)!);
    });
  }

  deleteStudent(id: string): RpcResult<{ classId: string }> {
    return rpc(() => {
      const cur = getStudent(this.sql, id) ?? fail("not_found", "학생을 찾을 수 없어요.", 404);
      this.sql.exec("DELETE FROM students WHERE id = ?", id);
      return { classId: cur.class_id };
    });
  }

  /** PIN 초기화: 새 무작위 초기 PIN, 등록 해제, 잠금 해제, 버전 증가(기존 학생 토큰 무효) */
  resetStudentPin(id: string): RpcResult<TeacherStudent> {
    return rpc(() => {
      if (!getStudent(this.sql, id)) fail("not_found", "학생을 찾을 수 없어요.", 404);
      this.sql.exec(
        `UPDATE students SET pin_hash = NULL, initial_pin = ?, pin_version = pin_version + 1, pin_failed = 0, locked_until = 0, updated_at = ? WHERE id = ?`,
        randomPin(), Date.now(), id,
      );
      return toTeacherStudent(getStudent(this.sql, id)!);
    });
  }

  unlockStudent(id: string): RpcResult<TeacherStudent> {
    return rpc(() => {
      if (!getStudent(this.sql, id)) fail("not_found", "학생을 찾을 수 없어요.", 404);
      this.sql.exec("UPDATE students SET pin_failed = 0, locked_until = 0 WHERE id = ?", id);
      return toTeacherStudent(getStudent(this.sql, id)!);
    });
  }

  /** 반에 연결된 보드 id 들 + 명단 사본 (Board DO 로 밀어 넣기용) */
  rosterSync(classId: string): { boardIds: string[]; members: RosterMember[] } {
    const boardIds = this.sql.exec<{ id: string }>("SELECT id FROM boards WHERE class_id = ?", classId).toArray().map((r) => r.id);
    return { boardIds, members: listStudents(this.sql, classId).map(toRosterMember) };
  }

  rosterForBoard(boardId: string): RosterMember[] {
    const b = getBoardRow(this.sql, boardId);
    if (!b?.class_id) return [];
    return listStudents(this.sql, b.class_id).map(toRosterMember);
  }

  /** 포트폴리오: 학생 + 그 반에 연결된 보드들 */
  portfolioTargets(studentId: string): { student: TeacherStudent; boards: BoardRecord[] } | null {
    const s = getStudent(this.sql, studentId);
    if (!s) return null;
    const boards = this.sql
      .exec<Record<string, SqlStorageValue>>("SELECT * FROM boards WHERE class_id = ? ORDER BY created_at", s.class_id)
      .toArray()
      .map((r) => toRecord(r as never));
    return { student: toTeacherStudent(s), boards };
  }

  // ───── 학생 입장 (태스크2) ─────

  /** PIN 해시 전용 비밀키 (SESSION_SECRET 을 바꿔도 PIN 이 깨지지 않도록 따로 보관) */
  private pinSecret(): string {
    const row = this.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = 'pin_secret'").toArray()[0];
    if (row) return row.value;
    const secret = randomToken(48);
    this.sql.exec("INSERT INTO meta (key, value) VALUES ('pin_secret', ?)", secret);
    return secret;
  }

  /** 명단 모드 입장: 학번 + PIN. 학번당 5회 실패 → 5분 잠금, IP 당 분당 실패 제한 */
  async studentLogin(input: { code: string; number: unknown; pin: unknown; ip: string }): Promise<RpcResult<LoginOutcome>> {
    return rpcAsync(async () => {
      const now = Date.now();
      const ipWait = ipBlockedFor(this.sql, input.ip, now);
      if (ipWait > 0) fail("too_many_attempts", "시도가 너무 많아요. 잠시 뒤에 다시 해 주세요.", 429, ipWait);
      const b = getBoardRowByCode(this.sql, input.code) ?? fail("not_found", "입장코드를 다시 확인해 주세요.", 404);
      if (b.archived) fail("archived", "보관된 보드예요. 선생님께 여쭤 보세요.", 403);
      if (b.entry_mode !== "roster") fail("wrong_entry_mode", "이 보드는 닉네임으로 들어가요.", 400);
      const badCreds = () => {
        recordIpFailure(this.sql, input.ip, now);
        return fail("invalid_credentials", "학번 또는 PIN을 다시 확인해 주세요.", 401);
      };
      let number: string;
      let pin: string;
      try {
        number = studentNumber(input.number);
        pin = pinValue(input.pin);
      } catch {
        return badCreds();
      }
      const s = b.class_id
        ? (this.sql.exec<StudentRow & Record<string, SqlStorageValue>>("SELECT * FROM students WHERE class_id = ? AND number = ?", b.class_id, number).toArray()[0] ?? null)
        : null;
      if (!s) return badCreds();
      if (s.locked_until > now) {
        fail("student_locked", "PIN을 여러 번 틀렸어요. 5분 뒤에 다시 해 주세요.", 429, s.locked_until - now);
      }
      const hashed = s.pin_hash !== null ? await hashPin(this.pinSecret(), s.pin_salt, pin) : null;
      // await 사이에 바뀌었을 수 있으니 다시 읽는다
      const cur = getStudent(this.sql, s.id);
      if (!cur || cur.pin_salt !== s.pin_salt || cur.pin_hash !== s.pin_hash) return badCreds();
      if (cur.locked_until > Date.now()) {
        fail("student_locked", "PIN을 여러 번 틀렸어요. 5분 뒤에 다시 해 주세요.", 429, cur.locked_until - Date.now());
      }
      if (!pinMatches(cur, pin, hashed)) {
        const { locked } = recordStudentFailure(this.sql, cur.id, Date.now());
        recordIpFailure(this.sql, input.ip, now);
        if (locked) fail("student_locked", "PIN을 5번 틀렸어요. 5분 뒤에 다시 해 주세요.", 429, 5 * 60_000);
        return fail("invalid_credentials", "학번 또는 PIN을 다시 확인해 주세요.", 401);
      }
      if (cur.pin_failed > 0) this.sql.exec("UPDATE students SET pin_failed = 0 WHERE id = ?", cur.id);
      return { board: toRecord(b), student: toAuthInfo(cur), needsSetup: cur.pin_hash === null };
    });
  }

  /** 처음 입장한 학생이 나만의 PIN 을 정한다 (초기 PIN 확인 후 발급된 setup 토큰 내용으로 호출) */
  async studentSetPin(input: { boardId: string; studentId: string; pinVersion: number; newPin: unknown }): Promise<RpcResult<{ board: BoardRecord; student: StudentAuthInfo }>> {
    return rpcAsync(async () => {
      const b = getBoardRow(this.sql, input.boardId) ?? fail("not_found", "보드를 찾을 수 없어요.", 404);
      if (b.archived) fail("archived", "보관된 보드예요. 선생님께 여쭤 보세요.", 403);
      const s = getStudent(this.sql, input.studentId);
      if (!s || s.class_id !== b.class_id || s.pin_version !== input.pinVersion || s.pin_hash !== null) {
        fail("unauthorized", "처음부터 다시 입장해 주세요.", 401);
      }
      const p = pinValue(input.newPin, "새 PIN");
      if (p === s!.initial_pin) fail("invalid_pin", "처음 받은 PIN과 다른 숫자 4자리로 정해 주세요.");
      if (p === "1111" || p === "0000" || p === "1234") fail("invalid_pin", "너무 쉬운 PIN이에요. 다른 숫자 4자리로 정해 주세요.");
      const hashed = await hashPin(this.pinSecret(), s!.pin_salt, p);
      const cur = getStudent(this.sql, input.studentId);
      if (!cur || cur.pin_version !== input.pinVersion || cur.pin_hash !== null) fail("unauthorized", "처음부터 다시 입장해 주세요.", 401);
      this.sql.exec(
        "UPDATE students SET pin_hash = ?, initial_pin = NULL, pin_version = pin_version + 1, pin_failed = 0, updated_at = ? WHERE id = ?",
        hashed, Date.now(), input.studentId,
      );
      return { board: toRecord(b), student: toAuthInfo(getStudent(this.sql, input.studentId)!) };
    });
  }

  /** 학생이 자기 닉네임을 바꾼다 (명단 학생: 반 전체에서 같은 닉네임) */
  setStudentNickname(studentId: string, nickname: unknown): RpcResult<StudentAuthInfo> {
    return rpc(() => {
      if (!getStudent(this.sql, studentId)) fail("not_found", "학생을 찾을 수 없어요.", 404);
      const n = line(nickname, LIMITS.nickname, "닉네임");
      this.sql.exec("UPDATE students SET nickname = ?, updated_at = ? WHERE id = ?", n, Date.now(), studentId);
      return toAuthInfo(getStudent(this.sql, studentId)!);
    });
  }

  private async refreshNow(): Promise<AccessTokenResult> {
    const owner = readOwner(this.sql);
    if (!owner) return { ok: false, reason: "not_connected" };
    if (owner.needs_reconnect === 1 || !owner.refresh_token) return { ok: false, reason: "reconnect_required" };
    const clientId = readVar(this.env, "GOOGLE_CLIENT_ID");
    const clientSecret = readVar(this.env, "GOOGLE_CLIENT_SECRET");
    if (!clientId || !clientSecret) return { ok: false, reason: "not_configured" };
    const usedToken = owner.refresh_token;
    try {
      const t = await refreshAccessToken({ clientId, clientSecret, refreshToken: usedToken });
      const expiresAt = Date.now() + Math.max(60, t.expires_in) * 1000;
      // 갱신 중에 소유자가 바뀌었으면 결과를 버린다.
      if (readOwner(this.sql)?.refresh_token !== usedToken) return { ok: false, reason: "google_error" };
      if (t.refresh_token && t.refresh_token !== usedToken) {
        this.sql.exec("UPDATE owner SET refresh_token = ?, updated_at = ? WHERE id = 1", t.refresh_token, Date.now());
      }
      this.tokenCache = { accessToken: t.access_token, expiresAt };
      return { ok: true, accessToken: t.access_token, expiresAt };
    } catch (e) {
      if (e instanceof GoogleTokenError) {
        if (e.oauthError === "invalid_grant") {
          // 만료·취소·비밀번호 변경 등: 다시 연결할 때까지 Google 을 다시 부르지 않는다.
          this.sql.exec(
            "UPDATE owner SET needs_reconnect = 1, updated_at = ? WHERE id = 1 AND refresh_token = ?",
            Date.now(),
            usedToken,
          );
          this.tokenCache = null;
          return { ok: false, reason: "reconnect_required" };
        }
        if (e.oauthError === "invalid_client" || e.oauthError === "unauthorized_client") {
          return { ok: false, reason: "not_configured" };
        }
      }
      return { ok: false, reason: "google_error" };
    }
  }
}
