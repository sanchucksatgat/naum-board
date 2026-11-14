import { createContext } from "preact";
import { useContext, useEffect, useReducer, useRef } from "preact/hooks";
import type { BoardConnection, ConnState, ServerState } from "../lib/realtime";
import type { TeacherModule } from "./teacher/types";

/** 글쓰기 대화상자를 열 때의 대상 */
export interface ComposeTarget {
  /** 고칠 카드 */
  editId?: string;
  /** 주제별 열 */
  columnId?: string;
  /** 교사: 이 학생 이름으로 */
  onBehalfOf?: string;
}

export interface BoardCtxValue {
  conn: BoardConnection;
  code: string;
  role: "teacher" | "student";
  /** 교사 전용 코드 (따로 불러옴). 학생이면 늘 null */
  teacher: TeacherModule | null;
  openComposer: (t: ComposeTarget) => void;
  openComments: (postId: string) => void;
  /** 프로젝터 보기: 읽기 전용, 큼직하게 */
  projector: boolean;
  /** 프로젝터에서 이름 숨김 */
  hideNames: boolean;
}

export const BoardCtx = createContext<BoardCtxValue | null>(null);

export function useBoard(): BoardCtxValue {
  const v = useContext(BoardCtx);
  if (!v) throw new Error("BoardCtx 없음");
  return v;
}

/**
 * 연결 상태에서 필요한 조각만 골라 구독. 고른 값이 eq 로 같으면 다시 그리지 않는다.
 * (카드 하나가 바뀌어도 그 카드만 다시 그려지게 하는 핵심)
 */
export function useConn<T>(sel: (s: ConnState) => T, eq: (a: T, b: T) => boolean = Object.is): T {
  const { conn } = useBoard();
  const [, force] = useReducer((n: number) => n + 1, 0);
  const selRef = useRef(sel);
  selRef.current = sel;
  const eqRef = useRef(eq);
  eqRef.current = eq;
  const value = sel(conn.getState());
  const valRef = useRef(value);
  valRef.current = value;
  useEffect(
    () =>
      conn.subscribe(() => {
        const next = selRef.current(conn.getState());
        if (!eqRef.current(valRef.current, next)) force(0);
      }),
    [conn],
  );
  return value;
}

/** 스냅숏을 받은 뒤에만 쓰는 화면용: view 가 반드시 있음 */
export function useView<T>(sel: (v: ServerState) => T, eq?: (a: T, b: T) => boolean): T {
  return useConn((s) => sel(s.view!), eq);
}

/** 파일 보기 주소 */
export function fileUrl(v: Pick<ServerState, "board" | "fileToken">, attachmentId: string): string {
  return `/api/files/${encodeURIComponent(v.board.id)}/${encodeURIComponent(attachmentId)}?t=${encodeURIComponent(v.fileToken)}`;
}
