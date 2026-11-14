/**
 * 반·명단·학생 PIN SQL (Registry DO 안에서만 호출). 태스크2.
 *
 * PIN 저장 (DESIGN §10): HMAC-SHA256(PIN 전용 서버 비밀키, 학생별 salt + ":" + PIN).
 * 4자리 PIN 의 안전은 시도 제한(학번당 5회 → 5분 잠금, IP 당 분당 실패 제한)이 책임진다.
 * 초기 PIN(교사가 정하거나 서버가 무작위로 만든 값)은 학생이 나만의 PIN 을 정할 때까지만 평문으로 둔다
 * (PIN 쪽지 인쇄용). 등록 후에는 해시만 남는다.
 */
import { LIMITS, type ClassSummary, type StudentRowInput, type TeacherStudent } from "../../shared/protocol";
import { base64UrlEncode, randomToken, timingSafeEqualStr } from "../auth/token";
import { fail, isPlainObject, line, pin as pinValue, studentNumber, ValidationError } from "../board/validate";

export interface StudentRow {
  id: string;
  class_id: string;
  number: string;
  name: string;
  nickname: string;
  group_name: string;
  pin_salt: string;
  pin_hash: string | null;
  initial_pin: string | null;
  pin_version: number;
  pin_failed: number;
  locked_until: number;
  created_at: number;
  updated_at: number;
}
type Row = StudentRow & Record<string, SqlStorageValue>;

/** Board DO 로 보내는 명단 사본 한 줄 */
export interface RosterMember {
  ref: string;
  number: string;
  name: string;
  nickname: string;
  group: string;
  /** PIN 버전. 바뀌면 Board DO 가 그 학생 연결을 끊는다 (기존 토큰 무효) */
  pinVersion: number;
}

export const STUDENT_REF_PREFIX = "s:";
export const studentRef = (id: string) => STUDENT_REF_PREFIX + id;

export const MAX_PIN_FAILURES = 5;
export const PIN_LOCK_MS = 5 * 60_000;
/** IP 당 1분 동안 허용하는 실패 수 (학교는 NAT 로 한 IP 를 공유하므로 실패만 센다) */
export const IP_FAILURE_LIMIT = 30;
export const IP_WINDOW_MS = 60_000;

export function toTeacherStudent(r: StudentRow, now = Date.now()): TeacherStudent {
  return {
    id: r.id,
    classId: r.class_id,
    ref: studentRef(r.id),
    number: r.number,
    name: r.name,
    nickname: r.nickname,
    group: r.group_name,
    pinRegistered: r.pin_hash !== null,
    initialPin: r.pin_hash === null ? (r.initial_pin ?? null) : null,
    lockedUntil: r.locked_until > now ? r.locked_until : null,
  };
}

export function toRosterMember(r: StudentRow): RosterMember {
  return { ref: studentRef(r.id), number: r.number, name: r.name, nickname: r.nickname, group: r.group_name, pinVersion: r.pin_version };
}

export function randomPin(): string {
  const n = crypto.getRandomValues(new Uint32Array(1))[0]! % 10000;
  return String(n).padStart(4, "0");
}

// ───── 반 ─────

export function classExists(sql: SqlStorage, id: string): boolean {
  return sql.exec("SELECT 1 FROM classes WHERE id = ?", id).toArray().length > 0;
}

export function listClasses(sql: SqlStorage): ClassSummary[] {
  return sql
    .exec<{ id: string; name: string; created_at: number; sc: number; bc: number }>(
      `SELECT c.id, c.name, c.created_at,
         (SELECT COUNT(*) FROM students s WHERE s.class_id = c.id) AS sc,
         (SELECT COUNT(*) FROM boards b WHERE b.class_id = c.id) AS bc
       FROM classes c ORDER BY c.created_at`,
    )
    .toArray()
    .map((r) => ({ id: r.id, name: r.name, studentCount: r.sc, boardCount: r.bc, createdAt: r.created_at }));
}

export function getClassSummary(sql: SqlStorage, id: string): ClassSummary | null {
  return listClasses(sql).find((c) => c.id === id) ?? null;
}

export function insertClass(sql: SqlStorage, name: string, now: number): string {
  const id = "c" + randomToken(9);
  sql.exec("INSERT INTO classes (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)", id, name, now, now);
  return id;
}

export function className(value: unknown): string {
  return line(value, LIMITS.className, "반 이름", true);
}

// ───── 학생 ─────

export function getStudent(sql: SqlStorage, id: string): StudentRow | null {
  return sql.exec<Row>("SELECT * FROM students WHERE id = ?", id).toArray()[0] ?? null;
}

export function listStudents(sql: SqlStorage, classId: string): StudentRow[] {
  const rows = sql.exec<Row>("SELECT * FROM students WHERE class_id = ?", classId).toArray();
  return rows.sort((a, b) => a.number.localeCompare(b.number, "ko", { numeric: true }));
}

interface CleanRow {
  number: string;
  name: string;
  pin: string;
  group: string;
  nickname: string;
}

/** CSV 를 파싱한 행들 검증. 오류 메시지에 몇 번째 줄인지 넣는다. */
export function validateRows(rows: unknown, existingNumbers: Set<string>): CleanRow[] {
  if (!Array.isArray(rows) || rows.length === 0) fail("bad_request", "학생을 1명 이상 넣어 주세요.");
  const list = rows as unknown[];
  if (list.length + existingNumbers.size > LIMITS.studentsPerClass) {
    fail("limit_reached", `한 반에는 학생을 ${LIMITS.studentsPerClass}명까지 넣을 수 있어요.`);
  }
  const seen = new Set(existingNumbers);
  return list.map((raw, i) => {
    const where = `${i + 1}번째 줄`;
    try {
      if (!isPlainObject(raw)) fail("bad_request", "학생 정보가 올바르지 않아요.");
      const r = raw as Record<string, unknown>;
      const number = studentNumber(r.number);
      const name = line(r.name, LIMITS.studentName, "이름", true);
      const group = line(r.group, LIMITS.groupName, "모둠");
      const nickname = line(r.nickname, LIMITS.nickname, "닉네임");
      const p = r.pin === undefined || r.pin === null || r.pin === "" ? randomPin() : pinValue(r.pin, "PIN");
      if (seen.has(number)) fail("duplicate", `학번 ${number} 이(가) 이미 있어요.`, 409);
      seen.add(number);
      return { number, name, pin: p, group, nickname };
    } catch (e) {
      if (e instanceof ValidationError) fail(e.code, `${where}: ${e.message}`, e.status);
      throw e;
    }
  });
}

export function insertStudents(sql: SqlStorage, classId: string, rows: CleanRow[], now: number): StudentRow[] {
  const ids: string[] = [];
  for (const r of rows) {
    const id = randomToken(9);
    ids.push(id);
    sql.exec(
      `INSERT INTO students (id, class_id, number, name, nickname, group_name, pin_salt, pin_hash, initial_pin, pin_version, pin_failed, locked_until, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, 0, 0, 0, ?, ?)`,
      id, classId, r.number, r.name, r.nickname, r.group, randomToken(12), r.pin, now, now,
    );
  }
  return ids.map((id) => getStudent(sql, id)!);
}

// ───── PIN ─────

const enc = new TextEncoder();

/** HMAC-SHA256(secret, salt + ":" + pin) → base64url */
export async function hashPin(secret: string, salt: string, pin: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return base64UrlEncode(await crypto.subtle.sign("HMAC", key, enc.encode(`${salt}:${pin}`)));
}

export function pinMatches(row: StudentRow, pin: string, hashed: string | null): boolean {
  if (row.pin_hash !== null) return hashed !== null && timingSafeEqualStr(row.pin_hash, hashed);
  return row.initial_pin !== null && timingSafeEqualStr(row.initial_pin, pin);
}

/** IP 실패 기록이 한도를 넘었으면 남은 시간(ms), 아니면 0 */
export function ipBlockedFor(sql: SqlStorage, ip: string, now: number): number {
  const r = sql.exec<{ window_start: number; count: number }>("SELECT window_start, count FROM login_throttle WHERE key = ?", "ip:" + ip).toArray()[0];
  if (!r || now - r.window_start >= IP_WINDOW_MS) return 0;
  return r.count >= IP_FAILURE_LIMIT ? r.window_start + IP_WINDOW_MS - now : 0;
}

export function recordIpFailure(sql: SqlStorage, ip: string, now: number): void {
  const key = "ip:" + ip;
  const r = sql.exec<{ window_start: number }>("SELECT window_start FROM login_throttle WHERE key = ?", key).toArray()[0];
  if (!r || now - r.window_start >= IP_WINDOW_MS) {
    sql.exec("INSERT OR REPLACE INTO login_throttle (key, window_start, count) VALUES (?, ?, 1)", key, now);
    // 가끔 오래된 기록 정리
    if (Math.random() < 0.05) sql.exec("DELETE FROM login_throttle WHERE window_start < ?", now - 60 * 60_000);
  } else {
    sql.exec("UPDATE login_throttle SET count = count + 1 WHERE key = ?", key);
  }
}

/** 학번별 실패 기록. 5회째에 5분 잠금 (실패 횟수는 0으로) */
export function recordStudentFailure(sql: SqlStorage, id: string, now: number): { locked: boolean } {
  const r = getStudent(sql, id);
  if (!r) return { locked: false };
  const failed = r.pin_failed + 1;
  if (failed >= MAX_PIN_FAILURES) {
    sql.exec("UPDATE students SET pin_failed = 0, locked_until = ? WHERE id = ?", now + PIN_LOCK_MS, id);
    return { locked: true };
  }
  sql.exec("UPDATE students SET pin_failed = ? WHERE id = ?", failed, id);
  return { locked: false };
}
