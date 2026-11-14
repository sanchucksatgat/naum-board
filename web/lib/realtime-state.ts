/**
 * 보드 상태 계산 (순수 함수만). 웹소켓·DOM 없이 단위 시험한다 (web/lib/realtime-state.test.ts).
 *
 * 두 겹으로 나눈다.
 *  - ServerState: 서버가 확정한 상태 (snapshot + 변경분)
 *  - 대기 중인 쓰기(PendingOp[]): 낙관적 반영. 화면에 보이는 상태 = derive(server, pending)
 * ack 가 오면 그 op 를 지우고, error 가 오면 지운다 → 되돌리기는 저절로 된다.
 * 새 항목(카드·댓글·공지·열)은 서버 id 를 ack 전까지 모르므로, 서버가 먼저 보내는 "내가 만든 새 항목" 방송을
 * 보낸 순서대로(FIFO) 대기 op 에 짝지어(matchedId) 임시 항목이 두 번 보이지 않게 한다.
 */
import type {
  AttachmentView,
  BackupInfo,
  BoardSettings,
  BoardSnapshot,
  ClientMessage,
  ColumnView,
  CommentView,
  MemberView,
  MeView,
  NoticeView,
  PostView,
  PresenceInfo,
  PublicMemberView,
  ServerMessage,
} from "../../src/shared/protocol";

/** 화면용 첨부: 올린 직후에는 서버 주소 대신 내 기기 미리보기를 쓴다 */
export interface ViewAttachment extends AttachmentView {
  previewUrl?: string;
}

/** 화면용 카드: 서버 PostView + 보내는 중 표시 */
export interface ViewPost extends Omit<PostView, "attachments" | "comments"> {
  attachments: ViewAttachment[];
  comments: ViewComment[];
  /** 아직 서버가 확인하지 않은 변경이 있음 */
  sending?: boolean;
}

export interface ViewComment extends CommentView {
  sending?: boolean;
}

export interface ServerState {
  board: { id: string; code: string };
  settings: BoardSettings;
  me: MeView;
  columns: ColumnView[];
  /** id → 카드 */
  posts: Record<string, ViewPost>;
  /** 카드 id, 오래된 것 먼저 (createdAt 순) */
  order: string[];
  notices: NoticeView[];
  members?: PublicMemberView[];
  roster?: MemberView[];
  notSubmitted?: string[];
  backup?: BackupInfo;
  presence: PresenceInfo;
  fileToken: string;
  fileTokenExpiresAt: number;
  /** 서버 시각 - 내 기기 시각 (ms) */
  clockOffset: number;
}

export type WriteMessage = Exclude<ClientMessage, { t: "sync" }>;

export interface PendingOp {
  opId: string;
  msg: WriteMessage;
  /** 서버가 먼저 방송한 새 항목 id (ack 전 짝짓기) */
  matchedId?: string;
  /** 낙관적 카드에 보일 첨부 (새 업로드의 미리보기 포함). post.save 전용 */
  attachments?: ViewAttachment[];
}

export function fromSnapshot(s: BoardSnapshot, now = Date.now()): ServerState {
  const posts: Record<string, ViewPost> = {};
  const order: string[] = [];
  for (const p of s.posts) {
    posts[p.id] = p;
    order.push(p.id);
  }
  const st: ServerState = {
    board: s.board,
    settings: s.settings,
    me: s.me,
    columns: sortColumns(s.columns),
    posts,
    order,
    notices: s.notices,
    presence: s.presence,
    fileToken: s.fileToken,
    fileTokenExpiresAt: s.fileTokenExpiresAt,
    clockOffset: typeof s.serverTime === "number" ? s.serverTime - now : 0,
  };
  if (s.members) st.members = s.members;
  if (s.roster) st.roster = s.roster;
  if (s.notSubmitted) st.notSubmitted = s.notSubmitted;
  if (s.backup) st.backup = s.backup;
  return st;
}

function sortColumns(cols: ColumnView[]): ColumnView[] {
  return [...cols].sort((a, b) => a.position - b.position);
}

/** createdAt 순서를 지키며 id 를 넣는다 (보통 끝에 붙으므로 뒤에서부터 찾는다) */
export function insertOrdered(order: string[], posts: Record<string, ViewPost>, id: string, createdAt: number): string[] {
  let i = order.length;
  while (i > 0) {
    const prev = posts[order[i - 1]!];
    if (!prev || prev.createdAt <= createdAt) break;
    i--;
  }
  const next = order.slice();
  next.splice(i, 0, id);
  return next;
}

function withPost(s: ServerState, id: string, fn: (p: ViewPost) => ViewPost): ServerState {
  const p = s.posts[id];
  if (!p) return s;
  const np = fn(p);
  if (np === p) return s;
  return { ...s, posts: { ...s.posts, [id]: np } };
}

function removePost(s: ServerState, id: string): ServerState {
  if (!s.posts[id]) return s;
  const posts = { ...s.posts };
  delete posts[id];
  return { ...s, posts, order: s.order.filter((x) => x !== id) };
}

function upsertPost(s: ServerState, post: ViewPost): ServerState {
  if (s.posts[post.id]) return { ...s, posts: { ...s.posts, [post.id]: post } };
  const posts = { ...s.posts, [post.id]: post };
  return { ...s, posts, order: insertOrdered(s.order, posts, post.id, post.createdAt) };
}

function upsertNotice(list: NoticeView[], n: NoticeView): NoticeView[] {
  const i = list.findIndex((x) => x.id === n.id);
  if (i >= 0) {
    const next = list.slice();
    next[i] = n;
    return next;
  }
  // 최신 먼저
  const next = [n, ...list];
  next.sort((a, b) => b.createdAt - a.createdAt);
  return next;
}

/** 서버 메시지 하나를 확정 상태에 반영. snapshot·ack·error 는 여기서 다루지 않는다(연결 계층이 처리). */
export function applyServerMessage(s: ServerState, m: ServerMessage): ServerState {
  switch (m.t) {
    case "post.upsert":
      return upsertPost(s, m.post);
    case "post.remove":
      return removePost(s, m.postId);
    case "comment.add":
      return withPost(s, m.comment.postId, (p) =>
        p.comments.some((c) => c.id === m.comment.id) ? p : { ...p, comments: [...p.comments, m.comment] },
      );
    case "comment.remove":
      return withPost(s, m.postId, (p) =>
        p.comments.some((c) => c.id === m.commentId) ? { ...p, comments: p.comments.filter((c) => c.id !== m.commentId) } : p,
      );
    case "like.set":
      return withPost(s, m.postId, (p) =>
        p.likeCount === m.count && p.likedByMe === m.liked ? p : { ...p, likeCount: m.count, likedByMe: m.liked },
      );
    case "notice.upsert":
      return { ...s, notices: upsertNotice(s.notices, m.notice) };
    case "notice.remove":
      return s.notices.some((n) => n.id === m.noticeId) ? { ...s, notices: s.notices.filter((n) => n.id !== m.noticeId) } : s;
    case "settings.update":
      return { ...s, settings: m.settings };
    case "columns.set":
      return { ...s, columns: sortColumns(m.columns) };
    case "presence":
      return { ...s, presence: m.presence };
    case "submission":
      return { ...s, notSubmitted: m.notSubmitted };
    case "backup.status":
      return { ...s, backup: m.backup };
    default:
      return s;
  }
}

/**
 * 서버 방송이 "내가 방금 만든 새 항목"이면 아직 짝이 없는 대기 op 중 가장 먼저 보낸 것과 짝짓는다.
 * 반드시 applyServerMessage 전에(이전 상태 기준으로) 부른다. 바뀐 것이 없으면 같은 배열을 돌려준다.
 */
export function matchCreates(prev: ServerState, pending: PendingOp[], m: ServerMessage): PendingOp[] {
  const pick = (pred: (op: PendingOp) => boolean, id: string): PendingOp[] => {
    if (pending.some((op) => op.matchedId === id)) return pending;
    const i = pending.findIndex((op) => !op.matchedId && pred(op));
    if (i < 0) return pending;
    const next = pending.slice();
    next[i] = { ...pending[i]!, matchedId: id };
    return next;
  };
  switch (m.t) {
    case "post.upsert":
      if (prev.posts[m.post.id]) return pending;
      return pick(
        (op) =>
          op.msg.t === "post.save" &&
          !op.msg.post.id &&
          (op.msg.post.onBehalfOf ? op.msg.post.onBehalfOf === m.post.authorRef : m.post.mine),
        m.post.id,
      );
    case "comment.add": {
      const post = prev.posts[m.comment.postId];
      if (!m.comment.mine || (post && post.comments.some((c) => c.id === m.comment.id))) return pending;
      return pick((op) => op.msg.t === "comment.add" && op.msg.postId === m.comment.postId, m.comment.id);
    }
    case "notice.upsert":
      if (prev.me.role !== "teacher" || prev.notices.some((n) => n.id === m.notice.id)) return pending;
      return pick((op) => op.msg.t === "notice.save" && !op.msg.notice.id, m.notice.id);
    case "columns.set": {
      const known = new Set(prev.columns.map((c) => c.id));
      let next = pending;
      for (const c of sortColumns(m.columns)) {
        if (known.has(c.id)) continue;
        next = matchCreatesColumn(next, c.id);
      }
      return next;
    }
    default:
      return pending;
  }
}

function matchCreatesColumn(pending: PendingOp[], id: string): PendingOp[] {
  if (pending.some((op) => op.matchedId === id)) return pending;
  const i = pending.findIndex((op) => !op.matchedId && op.msg.t === "column.save" && !op.msg.column.id);
  if (i < 0) return pending;
  const next = pending.slice();
  next[i] = { ...pending[i]!, matchedId: id };
  return next;
}

/** ack 의 결과 id 로 짝을 바로잡는다 (FIFO 짝짓기가 틀렸을 때를 대비) */
export function tmpId(opId: string): string {
  return "tmp:" + opId;
}

/** 새 카드가 놓일 열 (서버 규칙을 흉내: 주제별은 고른 열, 개인별·모둠별은 내 열, 교사는 "teacher") */
export function guessColumnId(s: ServerState, input: { columnId?: string; onBehalfOf?: string }): string | null {
  const mode = s.settings.columnMode;
  if (mode === "topic") return input.columnId ?? s.columns[0]?.id ?? null;
  if (s.me.role === "teacher") {
    if (input.onBehalfOf) {
      if (mode === "student") return "s:" + input.onBehalfOf;
      const g = s.roster?.find((r) => r.ref === input.onBehalfOf)?.group ?? "";
      return "g:" + g;
    }
    return "teacher";
  }
  return s.columns.find((c) => c.mine)?.id ?? null;
}

/** 대기 op 하나를 화면 상태에 겹친다 */
export function applyOptimistic(s: ServerState, op: PendingOp, now = Date.now()): ServerState {
  const m = op.msg;
  const student = s.me.role === "student";
  switch (m.t) {
    case "post.save": {
      const input = m.post;
      if (!input.id) {
        if (op.matchedId) return s; // 서버 카드가 이미 보임
        const t = now + s.clockOffset;
        const post: ViewPost = {
          id: tmpId(op.opId),
          columnId: guessColumnId(s, input),
          authorRef: input.onBehalfOf ?? s.me.ref,
          authorName: input.onBehalfOf ? (s.roster?.find((r) => r.ref === input.onBehalfOf)?.name ?? "") : s.me.name,
          mine: !input.onBehalfOf,
          title: input.title ?? "",
          body: input.body ?? "",
          link: input.link ?? "",
          status: student && s.settings.moderation ? "pending" : "visible",
          createdAt: t,
          updatedAt: t,
          attachments: op.attachments ?? [],
          comments: [],
          likeCount: 0,
          likedByMe: false,
          sending: true,
        };
        if (s.me.number && !input.onBehalfOf) post.authorNumber = s.me.number;
        return { ...s, posts: { ...s.posts, [post.id]: post }, order: [...s.order, post.id] };
      }
      return withPost(s, input.id, (p) => {
        const np: ViewPost = { ...p, sending: true };
        if (input.title !== undefined) np.title = input.title;
        if (input.body !== undefined) np.body = input.body;
        if (input.link !== undefined) np.link = input.link;
        if (input.attachments !== undefined) np.attachments = op.attachments ?? p.attachments;
        if (input.columnId !== undefined && s.settings.columnMode === "topic") np.columnId = input.columnId;
        if (student && s.settings.moderation && p.status === "visible") np.status = "pending";
        return np;
      });
    }
    case "post.delete":
      return removePost(s, m.postId);
    case "post.moderate":
      return withPost(s, m.postId, (p) => ({ ...p, status: m.action === "hide" ? "hidden" : "visible", sending: true }));
    case "comment.add": {
      if (op.matchedId) return s;
      const c: ViewComment = {
        id: tmpId(op.opId),
        postId: m.postId,
        authorRef: s.me.ref,
        authorName: s.me.name,
        mine: true,
        body: m.body,
        createdAt: now + s.clockOffset,
        sending: true,
      };
      return withPost(s, m.postId, (p) => ({ ...p, comments: [...p.comments, c] }));
    }
    case "comment.delete":
      return withPost(s, m.postId, (p) => ({ ...p, comments: p.comments.filter((c) => c.id !== m.commentId) }));
    case "like.set":
      return withPost(s, m.postId, (p) => {
        if (p.likedByMe === m.liked) return p;
        return { ...p, likedByMe: m.liked, likeCount: Math.max(0, p.likeCount + (m.liked ? 1 : -1)) };
      });
    case "feedback.set":
      return withPost(s, m.postId, (p) => {
        const np: ViewPost = { ...p };
        if (m.body.trim()) np.feedback = { body: m.body, updatedAt: now + s.clockOffset };
        else delete np.feedback;
        return np;
      });
    case "notice.save": {
      const t = now + s.clockOffset;
      if (m.notice.id) {
        const id = m.notice.id;
        return { ...s, notices: s.notices.map((n) => (n.id === id ? { ...n, title: m.notice.title, body: m.notice.body, updatedAt: t } : n)) };
      }
      if (op.matchedId) return s;
      return { ...s, notices: [{ id: tmpId(op.opId), title: m.notice.title, body: m.notice.body, createdAt: t, updatedAt: t }, ...s.notices] };
    }
    case "notice.delete":
      return { ...s, notices: s.notices.filter((n) => n.id !== m.noticeId) };
    case "settings.update":
      return { ...s, settings: { ...s.settings, ...m.patch } };
    case "column.save": {
      if (m.column.id) {
        const id = m.column.id;
        return { ...s, columns: s.columns.map((c) => (c.id === id ? { ...c, title: m.column.title } : c)) };
      }
      if (op.matchedId) return s;
      const pos = s.columns.reduce((mx, c) => Math.max(mx, c.position), -1) + 1;
      return { ...s, columns: [...s.columns, { id: tmpId(op.opId), title: m.column.title, kind: "topic", position: pos }] };
    }
    case "column.delete":
      return { ...s, columns: s.columns.filter((c) => c.id !== m.columnId) };
    case "column.reorder": {
      const pos = new Map(m.order.map((id, i) => [id, i]));
      const cols = s.columns.map((c) => (pos.has(c.id) ? { ...c, position: pos.get(c.id)! } : c));
      return { ...s, columns: sortColumns(cols) };
    }
    default:
      return s;
  }
}

/** 화면에 보일 상태 = 확정 상태 위에 대기 op 를 보낸 순서대로 겹친 것 */
export function derive(server: ServerState, pending: PendingOp[], now = Date.now()): ServerState {
  let v = server;
  for (const op of pending) v = applyOptimistic(v, op, now);
  return v;
}

/**
 * ack·error 를 받았을 때 대기 목록에서 지운다.
 * resultId(ack 의 새 항목 id)가 다른 op 에 잘못 짝지어져 있었다면 그 짝을 풀어 준다.
 */
export function settle(pending: PendingOp[], opId: string, resultId?: string): PendingOp[] {
  const i = pending.findIndex((op) => op.opId === opId);
  if (i < 0) return pending;
  const done = pending[i]!;
  let next = [...pending.slice(0, i), ...pending.slice(i + 1)];
  if (resultId && done.matchedId !== resultId && next.some((op) => op.matchedId === resultId)) {
    next = next.map((op) => {
      if (op.matchedId !== resultId) return op;
      const { matchedId: _drop, ...rest } = op;
      // 이 op 는 원래 done 이 짝지었던 항목의 주인일 수 있다
      return done.matchedId ? { ...rest, matchedId: done.matchedId } : rest;
    });
  }
  return next;
}

// ───────── 화면 도우미 (순수) ─────────

/** 열 하나에 들어갈 카드 id (최신 먼저) */
export function postIdsForColumn(s: ServerState, columnId: string): string[] {
  const out: string[] = [];
  for (let i = s.order.length - 1; i >= 0; i--) {
    const id = s.order[i]!;
    if (s.posts[id]?.columnId === columnId) out.push(id);
  }
  return out;
}

/** 어느 열에도 안 맞는 카드 (주제별 열이 지워졌을 때 등) */
export function orphanPostIds(s: ServerState): string[] {
  const ids = new Set(s.columns.map((c) => c.id));
  const out: string[] = [];
  for (let i = s.order.length - 1; i >= 0; i--) {
    const id = s.order[i]!;
    const p = s.posts[id];
    if (p && (p.columnId === null || !ids.has(p.columnId))) out.push(id);
  }
  return out;
}

/** 단일 주제 보드에서 내가 이미 쓴 카드 */
export function myOnlyPost(s: ServerState): ViewPost | null {
  if (s.settings.type !== "single" || s.me.role !== "student") return null;
  for (const id of s.order) {
    const p = s.posts[id];
    if (p?.mine) return p;
  }
  return null;
}

export function shallowEqualArray<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** 지수 백오프 + ±30% 무작위 (PROTOCOL §7) */
export function backoffDelay(attempt: number, random = Math.random): number {
  const base = Math.min(30_000, 500 * 2 ** Math.max(0, attempt));
  const jitter = 1 + (random() * 2 - 1) * 0.3;
  return Math.round(base * jitter);
}
