/**
 * 명단 붙여넣기·CSV 파싱과 CSV 만들기 (순수 함수, 화면과 무관 → 단위 시험 대상).
 *
 * 받는 모양
 * - 엑셀·구글 시트에서 복사한 표(탭으로 구분), CSV 파일(쉼표, 세미콜론), 따옴표 안의 쉼표·줄바꿈, BOM, CRLF
 * - 첫 줄이 제목(학번, 이름 …)이면 열 이름으로 찾고, 아니면 순서로 본다:
 *     2칸: 학번, 이름
 *     3칸: 학번, 이름, (숫자 4자리면 PIN, 아니면 모둠)
 *     4칸 이상: 학번, 이름, PIN, 모둠, 닉네임 (PROTOCOL §9 의 CSV 순서)
 * - 서버 규칙(src/worker/registry/roster.ts validateRows)과 같은 검사를 미리 해서 줄마다 오류를 보여 준다.
 */
import { LIMITS, type StudentRowInput, type TeacherStudent } from "../../src/shared/protocol";

export type RosterField = "number" | "name" | "pin" | "group" | "nickname";

export interface ParsedRosterRow {
  /** 원본에서 몇 번째 줄인지 (1부터, 제목 줄 포함) */
  line: number;
  number: string;
  name: string;
  pin: string;
  group: string;
  nickname: string;
  errors: string[];
  /** 저장은 되지만 알려 줄 것 (예: PIN 앞자리 0 보정) */
  notes: string[];
}

export interface RosterParseResult {
  rows: ParsedRosterRow[];
  /** 첫 줄을 제목으로 보았는지 */
  hasHeader: boolean;
  delimiter: "," | "\t" | ";";
  /** 어느 열을 무엇으로 읽었는지 (미리보기 안내용) */
  columns: RosterField[];
  /** 표 전체 문제 (예: 학번 열을 못 찾음) */
  problems: string[];
  /** 오류 없는 줄만 서버 모양으로 */
  valid: StudentRowInput[];
  errorCount: number;
}

const HEADER_NAMES: Record<RosterField, RegExp> = {
  number: /^(학번|번호|출석번호|학생번호|number|no\.?|student ?(id|number))$/i,
  name: /^(이름|성명|학생 ?이름|원래 ?이름|name)$/i,
  pin: /^(pin|핀|핀 ?번호|초기 ?pin|비밀번호|pin ?번호)$/i,
  group: /^(모둠|조|팀|그룹|모둠 ?이름|group|team)$/i,
  nickname: /^(닉네임|별명|보드 ?닉네임|nickname|nick)$/i,
};

function headerField(cell: string): RosterField | null {
  const c = cell.trim().replace(/\s+/g, " ");
  for (const f of Object.keys(HEADER_NAMES) as RosterField[]) if (HEADER_NAMES[f].test(c)) return f;
  return null;
}

/** 구분 문자 고르기: 따옴표 밖 첫 줄에서 탭 > 세미콜론(쉼표가 없을 때) > 쉼표 */
export function detectDelimiter(text: string): "," | "\t" | ";" {
  let first = "";
  let quoted = false;
  for (const ch of text) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && (ch === "\n" || ch === "\r")) {
      if (first.trim()) break;
      first = "";
      continue;
    }
    if (!quoted) first += ch;
  }
  if (first.includes("\t")) return "\t";
  if (!first.includes(",") && first.includes(";")) return ";";
  return ",";
}

/** RFC 4180 모양 CSV/TSV → 칸 배열. 따옴표 안 구분자·줄바꿈, "" 이스케이프, CR/LF/CRLF 모두 처리 */
export function parseDelimited(input: string, delimiter: string): string[][] {
  const text = input.replace(/^﻿/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let cellStarted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"' && !cellStarted) {
      quoted = true;
      cellStarted = true;
    } else if (ch === delimiter) {
      row.push(cell);
      cell = "";
      cellStarted = false;
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      cellStarted = false;
    } else {
      cell += ch;
      if (ch !== " ") cellStarted = true;
    }
  }
  row.push(cell);
  rows.push(row);
  return rows;
}

/** 숫자 칸 정리: 전각 숫자 → 반각, 엑셀 보호용 ' 제거, 공백 제거, "20301.0" → "20301" */
function cleanDigits(v: string): string {
  let s = v.normalize("NFKC").trim().replace(/^'/, "").replace(/\s+/g, "");
  if (/^\d+\.0+$/.test(s)) s = s.replace(/\.0+$/, "");
  return s;
}

function positionalColumns(width: number, sample: string[][]): RosterField[] {
  if (width <= 2) return ["number", "name"];
  if (width === 3) {
    const thirds = sample.map((r) => cleanDigits(r[2] ?? "")).filter(Boolean);
    const allPins = thirds.length > 0 && thirds.every((v) => /^\d{1,4}$/.test(v));
    return ["number", "name", allPins ? "pin" : "group"];
  }
  return ["number", "name", "pin", "group", "nickname"];
}

export interface ParseOptions {
  /** 이미 반에 있는 학번 (겹치면 오류) */
  existingNumbers?: Iterable<string>;
}

export function parseRoster(text: string, opts: ParseOptions = {}): RosterParseResult {
  const delimiter = detectDelimiter(text);
  const raw = parseDelimited(text, delimiter);
  // 원본 줄 번호를 기억하며 빈 줄 제거
  const lines = raw.map((cells, i) => ({ cells: cells.map((c) => c.trim()), line: i + 1 })).filter((r) => r.cells.some((c) => c !== ""));
  const problems: string[] = [];
  let hasHeader = false;
  let columns: RosterField[] = [];
  let index: Partial<Record<RosterField, number>> = {};

  const first = lines[0];
  if (first) {
    const fields = first.cells.map(headerField);
    if (fields.filter(Boolean).length >= 1 && !/^\d/.test(cleanDigits(first.cells[0] ?? ""))) {
      hasHeader = true;
      lines.shift();
      fields.forEach((f, i) => {
        if (f && index[f] === undefined) index[f] = i;
      });
      columns = first.cells.map((_, i) => (fields[i] ?? null)).filter((f): f is RosterField => f !== null);
      if (index.number === undefined) problems.push("제목 줄에서 ‘학번’ 열을 찾지 못했어요.");
      if (index.name === undefined) problems.push("제목 줄에서 ‘이름’ 열을 찾지 못했어요.");
    }
  }
  if (!hasHeader) {
    const width = Math.max(0, ...lines.map((l) => l.cells.length));
    columns = positionalColumns(width, lines.map((l) => l.cells));
    index = {};
    columns.forEach((f, i) => (index[f] = i));
  }

  const existing = new Set([...(opts.existingNumbers ?? [])].map(String));
  const seenAt = new Map<string, number>();
  const get = (cells: string[], f: RosterField) => (index[f] === undefined ? "" : (cells[index[f]!] ?? "").trim());

  const rows: ParsedRosterRow[] = lines.map(({ cells, line }) => {
    const errors: string[] = [];
    const notes: string[] = [];
    const number = cleanDigits(get(cells, "number"));
    const name = get(cells, "name").replace(/\s+/g, " ");
    let pin = cleanDigits(get(cells, "pin"));
    const group = get(cells, "group").replace(/\s+/g, " ");
    const nickname = get(cells, "nickname").replace(/\s+/g, " ");

    if (!number) errors.push("학번이 비어 있어요.");
    else if (!/^\d{1,20}$/.test(number)) errors.push("학번은 숫자 1~20자리로 써 주세요.");
    else if (existing.has(number)) errors.push(`학번 ${number}은(는) 이미 이 반에 있어요.`);
    else if (seenAt.has(number)) errors.push(`학번 ${number}이(가) ${seenAt.get(number)}번째 줄과 겹쳐요.`);
    if (number && !seenAt.has(number)) seenAt.set(number, line);

    if (!name) errors.push("이름이 비어 있어요.");
    else if (name.length > LIMITS.studentName) errors.push(`이름은 ${LIMITS.studentName}자까지 쓸 수 있어요.`);

    if (pin) {
      if (/^\d{1,3}$/.test(pin)) {
        const padded = pin.padStart(4, "0");
        notes.push(`PIN 앞의 0이 빠진 것 같아 ${padded}(으)로 맞췄어요.`);
        pin = padded;
      } else if (!/^\d{4}$/.test(pin)) errors.push("PIN은 숫자 4자리로 써 주세요. 비워 두면 자동으로 만들어요.");
    }
    if (group.length > LIMITS.groupName) errors.push(`모둠 이름은 ${LIMITS.groupName}자까지 쓸 수 있어요.`);
    if (nickname.length > LIMITS.nickname) errors.push(`닉네임은 ${LIMITS.nickname}자까지 쓸 수 있어요.`);
    return { line, number, name, pin, group, nickname, errors, notes };
  });

  if (!rows.length && !problems.length) problems.push("학생 정보가 없어요. 학번과 이름을 한 줄에 한 명씩 넣어 주세요.");
  if (rows.length + existing.size > LIMITS.studentsPerClass) problems.push(`한 반에는 학생을 ${LIMITS.studentsPerClass}명까지 넣을 수 있어요.`);

  const valid: StudentRowInput[] = problems.length
    ? []
    : rows
        .filter((r) => r.errors.length === 0)
        .map((r) => {
          const out: StudentRowInput = { number: r.number, name: r.name };
          if (r.pin) out.pin = r.pin;
          if (r.group) out.group = r.group;
          if (r.nickname) out.nickname = r.nickname;
          return out;
        });
  return { rows, hasHeader, delimiter, columns, problems, valid, errorCount: rows.filter((r) => r.errors.length).length };
}

// ───────────── CSV 만들기 ─────────────

/** 엑셀에서 수식으로 실행되지 않게 막고 따옴표로 감싼다 */
export function csvCell(value: unknown): string {
  let text = String(value ?? "");
  if (/^[=+\-@\t\r]/.test(text)) text = "'" + text;
  return '"' + text.replace(/"/g, '""') + '"';
}

/** 엑셀이 한글을 깨지 않게 BOM + CRLF */
export function toCsv(rows: unknown[][]): string {
  return "﻿" + rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

export const ROSTER_HEADER = ["학번", "이름", "PIN", "모둠", "닉네임"];

export function sampleRosterCsv(): string {
  return toCsv([
    ROSTER_HEADER,
    ["20301", "김하나", "", "1모둠", ""],
    ["20302", "이두리", "", "1모둠", ""],
    ["20303", "박세나", "", "2모둠", ""],
    ["20304", "최네오", "", "2모둠", "별빛"],
  ]);
}

export function compareNumber(a: { number: string }, b: { number: string }): number {
  return a.number.localeCompare(b.number, "ko", { numeric: true });
}

/** 명단 + PIN CSV (등록한 학생의 PIN 은 서버도 모름 → 빈칸 + 상태) */
export function rosterCsv(students: TeacherStudent[]): string {
  const sorted = [...students].sort(compareNumber);
  return toCsv([
    ["학번", "이름", "모둠", "닉네임", "초기 PIN", "PIN 상태"],
    ...sorted.map((s) => [s.number, s.name, s.group, s.nickname, s.initialPin ?? "", s.pinRegistered ? "학생이 직접 정함" : "처음 입장 전"]),
  ]);
}

/** 파일 이름에 못 쓰는 글자 정리 */
export function safeFileName(value: string, fallback = "명단"): string {
  const s = value.normalize("NFC").replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, "_").replace(/^[. ]+|[. ]+$/g, "").slice(0, 80);
  return s || fallback;
}

/** PIN 쪽지: 학번순 정렬 후 한 장(perPage)씩 나누기 */
export function paginate<T>(items: T[], perPage: number): T[][] {
  const n = Math.max(1, Math.floor(perPage));
  const pages: T[][] = [];
  for (let i = 0; i < items.length; i += n) pages.push(items.slice(i, i + n));
  return pages;
}
