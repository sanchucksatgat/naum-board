/**
 * 가시성 규칙 (DESIGN §6). 서버가 받는 사람마다 이 함수들로 걸러서 보낸다. 순수 함수만.
 *
 * 1. pending/hidden 카드는 작성자와 교사에게만.
 * 2. 피드백은 카드 작성자와 교사에게만.
 * 3. 익명 모드: 학생에게 다른 학생의 이름·학번·실제 ref 를 보내지 않는다 (별칭 "a:…" 과 "익명").
 *    개인별 열 id·제목도 별칭으로 바꾸고, 학생 목록(members)은 보내지 않는다.
 * 4. 학생은 다른 학생의 실명을 받지 않는다: 닉네임이 있으면 닉네임만 (기존 탭보드 규칙). 교사는 실명+닉네임.
 * 5. 좋아요는 수와 "내가 눌렀는지"만. 누가 눌렀는지는 아무에게도 안 보낸다.
 */
import type {
  AttachmentView, BoardSettings, ColumnView, CommentView, MemberView, MeView, NoticeView, PostView, PublicMemberView, Role,
} from "../../shared/protocol";
import type { AttachmentRow, ColumnRow, CommentRow, MemberRow, NoticeRow, PostParts, PostRow } from "./model";
import { compareKo } from "./validate";

export const TEACHER_REF = "teacher";
export const TEACHER_NAME = "선생님";
export const ANON_NAME = "익명";
export const TEACHER_COLUMN_ID = "teacher";

export interface Viewer {
  role: Role;
  ref: string;
}

export interface ViewCtx {
  settings: BoardSettings;
  members: Map<string, MemberRow>;
  /** 주제별 열 (주제별 모드에서 열 없는 카드는 첫 열로) */
  topicColumns: ColumnRow[];
  viewer: Viewer;
}

export const isTeacher = (v: Viewer) => v.role === "teacher";

export function canSeePost(post: Pick<PostRow, "status" | "author_ref">, viewer: Viewer): boolean {
  return post.status === "visible" || isTeacher(viewer) || post.author_ref === viewer.ref;
}

/** 학생 화면에 실제 정보를 보여도 되는 ref 인가 (본인, 교사, 또는 익명 아님) */
function revealTo(ref: string, ctx: ViewCtx): boolean {
  return isTeacher(ctx.viewer) || ref === TEACHER_REF || ref === ctx.viewer.ref || !ctx.settings.anonymous;
}

export function displayName(m: Pick<MemberRow, "name" | "nickname"> | undefined, fallback: string): string {
  if (!m) return fallback;
  return m.nickname || m.name;
}

export function anonRef(m: MemberRow | undefined, ref: string): string {
  // 별칭이 없는 경우(구성원 기록이 없는 옛 카드)는 ref 를 그대로 쓰지 않고 고정 문자열
  return "a:" + (m?.alias ?? "x" + simpleHash(ref));
}

function simpleHash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(16);
}

export interface AuthorFields {
  authorRef: string;
  authorName: string;
  authorNumber?: string;
}

export function authorFields(ref: string, storedName: string, ctx: ViewCtx): AuthorFields {
  if (ref === TEACHER_REF) return { authorRef: TEACHER_REF, authorName: TEACHER_NAME };
  const m = ctx.members.get(ref);
  if (isTeacher(ctx.viewer)) {
    const out: AuthorFields = { authorRef: ref, authorName: m ? m.name : storedName };
    if (m?.number) out.authorNumber = m.number;
    return out;
  }
  if (!revealTo(ref, ctx)) return { authorRef: anonRef(m, ref), authorName: ANON_NAME };
  // 학생에게 실명은 닉네임이 없을 때만. 카드에 저장된 이름(storedName)은 실명일 수 있어 쓰지 않는다.
  const out: AuthorFields = { authorRef: ref, authorName: m ? displayName(m, "") : "학생" };
  if (m?.number) out.authorNumber = m.number;
  return out;
}

export function attachmentView(a: AttachmentRow): AttachmentView {
  const v: AttachmentView = { id: a.id, name: a.name, mime: a.mime, size: a.size, kind: a.kind };
  if (a.width) v.width = a.width;
  if (a.height) v.height = a.height;
  return v;
}

export function commentView(c: CommentRow, ctx: ViewCtx): CommentView {
  const a = authorFields(c.author_ref, c.author_name, ctx);
  const v: CommentView = {
    id: c.id,
    postId: c.post_id,
    authorRef: a.authorRef,
    authorName: a.authorName,
    mine: c.author_ref === ctx.viewer.ref,
    body: c.body,
    createdAt: c.created_at,
  };
  if (isTeacher(ctx.viewer) && a.authorNumber) v.authorNumber = a.authorNumber;
  return v;
}

/** 카드가 놓일 열 id (받는 사람 기준: 익명이면 별칭) */
export function columnIdFor(post: PostRow, ctx: ViewCtx): string | null {
  const mode = ctx.settings.columnMode;
  if (mode === "topic") {
    if (post.column_id && ctx.topicColumns.some((c) => c.id === post.column_id)) return post.column_id;
    return ctx.topicColumns[0]?.id ?? null;
  }
  if (post.author_ref === TEACHER_REF) return TEACHER_COLUMN_ID;
  const m = ctx.members.get(post.author_ref);
  if (mode === "group") return "g:" + (m?.group_name ?? "");
  return "s:" + (revealTo(post.author_ref, ctx) ? post.author_ref : anonRef(m, post.author_ref));
}

/** 카드 보기. 볼 수 없는 카드면 null (호출하는 쪽에서 post.remove 로 처리) */
export function postView(post: PostRow, parts: PostParts, ctx: ViewCtx): PostView | null {
  if (!canSeePost(post, ctx.viewer)) return null;
  const a = authorFields(post.author_ref, post.author_name, ctx);
  const v: PostView = {
    id: post.id,
    columnId: columnIdFor(post, ctx),
    authorRef: a.authorRef,
    authorName: a.authorName,
    mine: post.author_ref === ctx.viewer.ref,
    title: post.title,
    body: post.body,
    link: post.link,
    status: post.status,
    createdAt: post.created_at,
    updatedAt: post.updated_at,
    attachments: parts.attachments.map(attachmentView),
    comments: parts.comments.map((c) => commentView(c, ctx)),
    likeCount: parts.likers.size,
    likedByMe: parts.likers.has(ctx.viewer.ref),
  };
  if (a.authorNumber) v.authorNumber = a.authorNumber;
  if (parts.feedback && (isTeacher(ctx.viewer) || post.author_ref === ctx.viewer.ref)) {
    v.feedback = { body: parts.feedback.body, updatedAt: parts.feedback.updated_at };
  }
  return v;
}

export function noticeView(n: NoticeRow): NoticeView {
  return { id: n.id, title: n.title, body: n.body, createdAt: n.created_at, updatedAt: n.updated_at };
}

export function activeMembers(members: Map<string, MemberRow>, kind?: MemberRow["kind"]): MemberRow[] {
  const out: MemberRow[] = [];
  for (const m of members.values()) if (!m.removed && (!kind || m.kind === kind)) out.push(m);
  return out.sort((a, b) => compareKo(a.number, b.number) || compareKo(a.name, b.name) || (a.created_at - b.created_at));
}

/** 지금 입장 방식에 맞는 구성원 (명단 모드: 명단 학생, 자유 모드: 자유 입장 학생) */
export function boardMembers(ctx: Pick<ViewCtx, "members" | "settings">): MemberRow[] {
  return activeMembers(ctx.members, ctx.settings.entryMode === "roster" ? "roster" : "free");
}

export function columnsView(ctx: ViewCtx): ColumnView[] {
  const mode = ctx.settings.columnMode;
  if (mode === "topic") {
    return ctx.topicColumns.map((c, i) => ({ id: c.id, title: c.title, kind: "topic" as const, position: i }));
  }
  const teacherCol: ColumnView = { id: TEACHER_COLUMN_ID, title: TEACHER_NAME, kind: "teacher", position: 0 };
  const list = boardMembers(ctx);
  const me = ctx.members.get(ctx.viewer.ref);
  if (mode === "group") {
    const groups = [...new Set(list.map((m) => m.group_name))].sort((a, b) => (a === "" ? 1 : b === "" ? -1 : compareKo(a, b)));
    return [
      teacherCol,
      ...groups.map((g, i) => {
        const col: ColumnView = { id: "g:" + g, title: g || "모둠 없음", kind: "group", position: i + 1 };
        if (me && !me.removed && me.group_name === g) col.mine = true;
        return col;
      }),
    ];
  }
  // 개인별
  const anonymous = ctx.settings.anonymous && !isTeacher(ctx.viewer);
  const ordered = anonymous ? [...list].sort((a, b) => (a.alias < b.alias ? -1 : a.alias > b.alias ? 1 : 0)) : list;
  let n = 0;
  return [
    teacherCol,
    ...ordered.map((m, i) => {
      const mine = m.ref === ctx.viewer.ref;
      const reveal = !anonymous || mine;
      const ref = reveal ? m.ref : anonRef(m, m.ref);
      let title: string;
      if (isTeacher(ctx.viewer)) title = m.number ? `${m.number} ${m.name}` : m.name;
      else if (reveal) title = displayName(m, "학생");
      else title = `${ANON_NAME} ${++n}`;
      const col: ColumnView = { id: "s:" + ref, title, kind: "student", ownerRef: ref, position: i + 1 };
      if (mine) col.mine = true;
      return col;
    }),
  ];
}

export function teacherMemberViews(members: Map<string, MemberRow>): MemberView[] {
  return activeMembers(members).map((m) => {
    const v: MemberView = { ref: m.ref, kind: m.kind, name: m.name, nickname: m.nickname, group: m.group_name };
    if (m.number) v.number = m.number;
    return v;
  });
}

/** 학생에게 주는 구성원 목록. 익명이면 undefined (아예 안 보냄) */
export function publicMemberViews(ctx: ViewCtx): PublicMemberView[] | undefined {
  if (ctx.settings.anonymous) return undefined;
  return boardMembers(ctx).map((m) => {
    const v: PublicMemberView = { ref: m.ref, name: displayName(m, "학생"), group: m.group_name };
    if (m.number) v.number = m.number;
    return v;
  });
}

export function meView(ctx: ViewCtx, fallbackName: string): MeView {
  if (isTeacher(ctx.viewer)) return { role: "teacher", ref: TEACHER_REF, name: TEACHER_NAME };
  const m = ctx.members.get(ctx.viewer.ref);
  const v: MeView = { role: "student", ref: ctx.viewer.ref, name: m ? displayName(m, fallbackName) : fallbackName };
  if (m) {
    if (m.kind === "roster") v.realName = m.name;
    if (m.number) v.number = m.number;
    v.nickname = m.nickname;
    if (m.group_name) v.group = m.group_name;
  }
  return v;
}

/** 명단 모드에서 아직 카드가 하나도 없는 학생 ref (교사용) */
export function notSubmitted(ctx: Pick<ViewCtx, "members" | "settings">, authorRefs: Set<string>): string[] {
  if (ctx.settings.entryMode !== "roster") return [];
  return activeMembers(ctx.members, "roster")
    .filter((m) => !authorRefs.has(m.ref))
    .map((m) => m.ref);
}
