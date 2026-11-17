/** 표시용 작은 함수들 (순수) */
import { formatBoardCode, type BackupInfo, type BoardSummary, type BoardType, type ColumnMode, type EntryMode } from "../../src/shared/protocol";

export const TYPE_LABEL: Record<BoardType, string> = { single: "학생당 1카드", cumulative: "여러 장 누적" };
export const COLUMN_LABEL: Record<ColumnMode, string> = { student: "개인별", group: "모둠별", topic: "주제별" };
export const ENTRY_LABEL: Record<EntryMode, string> = { roster: "명단 입장", free: "자유 입장" };

/** "방금", "5분 전", "3시간 전", "어제", "4일 전", 그보다 오래면 날짜 */
export function relativeTime(ts: number | null | undefined, now = Date.now()): string {
  if (!ts) return "아직 없음";
  const diff = Math.max(0, now - ts);
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "방금";
  if (min < 60) return `${min}분 전`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}시간 전`;
  const day = Math.floor(hr / 24);
  if (day === 1) return "어제";
  if (day < 7) return `${day}일 전`;
  return formatDate(ts);
}

export function formatDate(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}. ${d.getMonth() + 1}. ${d.getDate()}.`;
}

export function formatDateTime(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${formatDate(ts)} ${hh}:${mm}`;
}

/** 보드 검색: 제목·코드·반 이름 (대소문자·공백 무시) */
export function matchesBoard(b: Pick<BoardSummary, "title" | "code" | "className">, query: string): boolean {
  const q = query.trim().toLocaleLowerCase("ko").replace(/\s+/g, "");
  if (!q) return true;
  return `${b.title}${b.code}${b.className ?? ""}`.toLocaleLowerCase("ko").replace(/\s+/g, "").includes(q);
}

/** 최근 활동 순 (활동 없으면 만든 시각) */
export function sortBoards<T extends Pick<BoardSummary, "lastPostAt" | "updatedAt" | "createdAt">>(boards: T[]): T[] {
  const key = (b: T) => Math.max(b.lastPostAt ?? 0, b.updatedAt ?? 0, b.createdAt ?? 0);
  return [...boards].sort((a, b) => key(b) - key(a));
}

export type Tone = "ok" | "warn" | "danger" | "muted";

/** 백업 상태 → 한 줄 문장 */
export function backupText(b: BackupInfo | undefined | null, now = Date.now()): { text: string; tone: Tone } {
  if (!b) return { text: "백업 상태를 알 수 없어요.", tone: "muted" };
  switch (b.state) {
    case "ok":
      return { text: `드라이브에 백업됨 (${relativeTime(b.lastSuccessAt, now)})`, tone: "ok" };
    case "pending":
      return { text: "곧 드라이브에 백업해요 (30초 안).", tone: "muted" };
    case "never":
      return { text: "아직 백업할 글이 없어요.", tone: "muted" };
    case "unavailable":
      return { text: "드라이브 연결이 끊겨 백업하지 못하고 있어요. 위의 ‘다시 연결’을 눌러 주세요.", tone: "danger" };
    case "error":
      return {
        text: `백업이 잠시 실패했어요${b.lastError ? `: ${b.lastError.replace(/[.。]\s*$/, "")}` : ""}. 자동으로 다시 시도해요.`,
        tone: "warn",
      };
  }
}

/** 학생 입장 주소 */
export function studentUrl(origin: string, code: string): string {
  return `${origin.replace(/\/+$/, "")}/b/${code}`;
}

/** 읽기 쉬운 입장코드: "4821" 그대로, 예전 6자 "K7QX2M" → "K7Q X2M" */
export const spacedCode = formatBoardCode;

/** 주제 이름 입력(줄바꿈·쉼표 구분) → 정리된 목록 */
export function parseTopics(input: string, max = 30, maxLen = 60): string[] {
  const out: string[] = [];
  for (const raw of input.split(/[\n,]/)) {
    const t = raw.trim().replace(/\s+/g, " ").slice(0, maxLen);
    if (t && !out.includes(t)) out.push(t);
    if (out.length >= max) break;
  }
  return out;
}
