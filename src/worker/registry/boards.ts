/** 보드 목록 SQL (Registry DO 안에서만 호출). 태스크2. */
import {
  BOARD_CODE_DIGITS, BOARD_CODE_MAX_DIGITS, LIMITS,
  type BoardSummary, type BoardType, type ColumnMode, type EntryMode, type RecentPost,
} from "../../shared/protocol";
import { randomToken } from "../auth/token";
import { fail } from "../board/validate";

export interface BoardRow {
  id: string;
  code: string;
  title: string;
  type: BoardType;
  column_mode: ColumnMode;
  entry_mode: EntryMode;
  class_id: string | null;
  locked: number;
  archived: number;
  created_at: number;
  updated_at: number;
  drive_folder_id: string | null;
  post_count: number;
  last_post_at: number | null;
  recent_json: string;
}

/** Registry 가 원본으로 갖는 보드 값 (Board DO 는 사본). */
export interface BoardRecord {
  id: string;
  code: string;
  title: string;
  type: BoardType;
  columnMode: ColumnMode;
  entryMode: EntryMode;
  classId: string | null;
  locked: boolean;
  archived: boolean;
  createdAt: number;
  updatedAt: number;
  driveFolderId: string | null;
}

/** DESIGN §10 resolveBoardByCode 결과 (계약 필드 + 추가 필드) */
export interface ResolvedBoard {
  id: string;
  code: string;
  title: string;
  archived: boolean;
  entryMode: EntryMode;
  locked: boolean;
}

export type BoardMetaPatch = Partial<Pick<BoardRecord, "title" | "type" | "columnMode" | "entryMode" | "classId" | "locked" | "archived">>;

/** Board DO 가 알람 때 보내는 통계 + 최근 글 (교사 대시보드용) */
export interface BoardStats {
  postCount: number;
  lastPostAt: number | null;
  recent: Array<Omit<RecentPost, "boardId" | "boardCode" | "boardTitle" | "fileToken">>;
}

type Row = BoardRow & Record<string, SqlStorageValue>;

export function toRecord(r: BoardRow): BoardRecord {
  return {
    id: r.id,
    code: r.code,
    title: r.title,
    type: r.type,
    columnMode: r.column_mode,
    entryMode: r.entry_mode,
    classId: r.class_id,
    locked: r.locked === 1,
    archived: r.archived === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    driveFolderId: r.drive_folder_id,
  };
}

/** 숫자 n자리 (crypto 난수, 250 이상은 버려서 치우침 없게). 앞자리 0도 그대로 */
export function randomNumericCode(n: number): string {
  let out = "";
  while (out.length < n) {
    for (const b of crypto.getRandomValues(new Uint8Array(n * 2))) {
      if (b >= 250) continue;
      out += String(b % 10);
      if (out.length === n) break;
    }
  }
  return out;
}

/** 너무 쉽게 짐작되는 코드: 같은 숫자 반복(1111), 1씩 오르내림(1234, 4321, 7890), 두 숫자 번갈아(1212) */
export function isGuessableCode(code: string): boolean {
  const d = [...code].map(Number);
  const same = d.every((x) => x === d[0]);
  const step = (k: number) => d.every((x, i) => i === 0 || x === (d[i - 1]! + k + 10) % 10);
  const alternating = d.every((x, i) => x === d[i % 2]);
  return same || step(1) || step(-1) || alternating;
}

/** 한 자리 수에서 이만큼 겹치면(설치 안에 보드가 아주 많으면) 한 자리 늘린다 */
export const CODE_TRIES_PER_LENGTH = 12;

/** 새 입장코드 고르기: 4자리 → (붐비면) 5자리 → 6자리. 다 실패하면 null */
export function pickBoardCode(isTaken: (code: string) => boolean): string | null {
  for (let n = BOARD_CODE_DIGITS; n <= BOARD_CODE_MAX_DIGITS; n++) {
    for (let i = 0; i < CODE_TRIES_PER_LENGTH; i++) {
      const code = randomNumericCode(n);
      if (isGuessableCode(code) || isTaken(code)) continue;
      return code;
    }
  }
  return null;
}

export function getBoardRow(sql: SqlStorage, id: string): BoardRow | null {
  return sql.exec<Row>("SELECT * FROM boards WHERE id = ?", id).toArray()[0] ?? null;
}

export function getBoardRowByCode(sql: SqlStorage, code: string): BoardRow | null {
  return sql.exec<Row>("SELECT * FROM boards WHERE code = ?", code).toArray()[0] ?? null;
}

export interface CreateBoardInput {
  title: string;
  type: BoardType;
  columnMode: ColumnMode;
  entryMode: EntryMode;
  classId: string | null;
  locked: boolean;
}

export function insertBoard(sql: SqlStorage, input: CreateBoardInput, now: number): BoardRecord {
  if (input.classId && !sql.exec("SELECT 1 FROM classes WHERE id = ?", input.classId).toArray().length) {
    fail("not_found", "연결할 반을 찾을 수 없어요.", 404);
  }
  const id = "b" + randomToken(9);
  const code = pickBoardCode((c) => getBoardRowByCode(sql, c) !== null);
  if (code) {
    sql.exec(
      `INSERT INTO boards (id, code, title, type, column_mode, entry_mode, class_id, locked, archived, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      id, code, input.title, input.type, input.columnMode, input.entryMode, input.classId, input.locked ? 1 : 0, now, now,
    );
    return toRecord(getBoardRow(sql, id)!);
  }
  return fail("internal", "입장코드를 만들지 못했어요. 다시 시도해 주세요.", 500);
}

export function updateBoardRow(sql: SqlStorage, id: string, patch: BoardMetaPatch, now: number): BoardRecord | null {
  const cur = getBoardRow(sql, id);
  if (!cur) return null;
  if (patch.classId && !sql.exec("SELECT 1 FROM classes WHERE id = ?", patch.classId).toArray().length) {
    fail("not_found", "연결할 반을 찾을 수 없어요.", 404);
  }
  const next = { ...toRecord(cur), ...patch };
  sql.exec(
    `UPDATE boards SET title = ?, type = ?, column_mode = ?, entry_mode = ?, class_id = ?, locked = ?, archived = ?, updated_at = ? WHERE id = ?`,
    next.title, next.type, next.columnMode, next.entryMode, next.classId, next.locked ? 1 : 0, next.archived ? 1 : 0, now, id,
  );
  return toRecord(getBoardRow(sql, id)!);
}

export function listBoardSummaries(sql: SqlStorage, filter: "active" | "archived" | "all"): BoardSummary[] {
  const where = filter === "active" ? "WHERE b.archived = 0" : filter === "archived" ? "WHERE b.archived = 1" : "";
  const rows = sql
    .exec<Row & { class_name: string | null }>(
      `SELECT b.*, c.name AS class_name FROM boards b LEFT JOIN classes c ON c.id = b.class_id ${where} ORDER BY b.created_at DESC`,
    )
    .toArray();
  return rows.map((r) => toSummary(r, r.class_name));
}

export function getBoardSummary(sql: SqlStorage, id: string): BoardSummary | null {
  const r = sql
    .exec<Row & { class_name: string | null }>(
      "SELECT b.*, c.name AS class_name FROM boards b LEFT JOIN classes c ON c.id = b.class_id WHERE b.id = ?",
      id,
    )
    .toArray()[0];
  return r ? toSummary(r, r.class_name) : null;
}

function toSummary(r: BoardRow, className: string | null): BoardSummary {
  const rec = toRecord(r);
  return {
    id: rec.id,
    code: rec.code,
    title: rec.title,
    type: rec.type,
    columnMode: rec.columnMode,
    entryMode: rec.entryMode,
    locked: rec.locked,
    archived: rec.archived,
    classId: rec.classId,
    className,
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
    postCount: r.post_count,
    lastPostAt: r.last_post_at,
  };
}

export function saveBoardStats(sql: SqlStorage, id: string, stats: BoardStats): void {
  const recent = JSON.stringify(stats.recent.slice(0, 12));
  sql.exec(
    "UPDATE boards SET post_count = ?, last_post_at = ?, recent_json = ? WHERE id = ?",
    Math.max(0, Math.floor(stats.postCount)), stats.lastPostAt, recent, id,
  );
}

export function recentPosts(sql: SqlStorage, limit: number): RecentPost[] {
  const n = Math.max(1, Math.min(50, Math.floor(limit) || 12));
  const rows = sql
    .exec<{ id: string; code: string; title: string; recent_json: string }>(
      "SELECT id, code, title, recent_json FROM boards WHERE archived = 0 AND last_post_at IS NOT NULL ORDER BY last_post_at DESC LIMIT 100",
    )
    .toArray();
  const all: RecentPost[] = [];
  for (const r of rows) {
    let list: BoardStats["recent"] = [];
    try {
      list = JSON.parse(r.recent_json) as BoardStats["recent"];
    } catch {
      list = [];
    }
    for (const p of list) all.push({ ...p, boardId: r.id, boardCode: r.code, boardTitle: r.title });
  }
  all.sort((a, b) => b.createdAt - a.createdAt || (a.postId < b.postId ? 1 : -1));
  return all.slice(0, n);
}

export const BOARD_TITLE_MAX = LIMITS.boardTitle;
