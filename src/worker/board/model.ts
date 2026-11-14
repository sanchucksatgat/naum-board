/** Board DO SQLite 스키마와 행 타입·조회 (DESIGN §5). */

/** 규칙은 Registry 와 같다: 배포된 항목은 고치지 말고 끝에 추가. */
export const BOARD_MIGRATIONS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS meta (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL
   );
   CREATE TABLE IF NOT EXISTS columns (
     id TEXT PRIMARY KEY,
     title TEXT NOT NULL,
     kind TEXT NOT NULL,
     owner_ref TEXT,
     position REAL NOT NULL,
     created_at INTEGER NOT NULL
   );
   CREATE TABLE IF NOT EXISTS posts (
     id TEXT PRIMARY KEY,
     column_id TEXT,
     author_ref TEXT NOT NULL,
     author_name TEXT NOT NULL,
     created_by TEXT NOT NULL,
     title TEXT NOT NULL DEFAULT '',
     body TEXT NOT NULL DEFAULT '',
     link TEXT NOT NULL DEFAULT '',
     status TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   );
   CREATE INDEX IF NOT EXISTS posts_author ON posts (author_ref);
   CREATE TABLE IF NOT EXISTS attachments (
     id TEXT PRIMARY KEY,
     post_id TEXT NOT NULL,
     position INTEGER NOT NULL,
     drive_file_id TEXT NOT NULL,
     name TEXT NOT NULL,
     mime TEXT NOT NULL,
     size INTEGER NOT NULL,
     kind TEXT NOT NULL,
     width INTEGER,
     height INTEGER,
     by_ref TEXT NOT NULL,
     created_at INTEGER NOT NULL
   );
   CREATE INDEX IF NOT EXISTS attachments_post ON attachments (post_id);
   CREATE TABLE IF NOT EXISTS comments (
     id TEXT PRIMARY KEY,
     post_id TEXT NOT NULL,
     author_ref TEXT NOT NULL,
     author_name TEXT NOT NULL,
     body TEXT NOT NULL,
     created_at INTEGER NOT NULL
   );
   CREATE INDEX IF NOT EXISTS comments_post ON comments (post_id);
   CREATE TABLE IF NOT EXISTS likes (
     post_id TEXT NOT NULL,
     author_ref TEXT NOT NULL,
     PRIMARY KEY (post_id, author_ref)
   ) WITHOUT ROWID;
   CREATE TABLE IF NOT EXISTS feedback (
     post_id TEXT PRIMARY KEY,
     body TEXT NOT NULL,
     updated_at INTEGER NOT NULL
   );
   CREATE TABLE IF NOT EXISTS notices (
     id TEXT PRIMARY KEY,
     title TEXT NOT NULL,
     body TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   );
   CREATE TABLE IF NOT EXISTS members (
     ref TEXT PRIMARY KEY,
     kind TEXT NOT NULL,
     number TEXT NOT NULL DEFAULT '',
     name TEXT NOT NULL,
     nickname TEXT NOT NULL DEFAULT '',
     group_name TEXT NOT NULL DEFAULT '',
     alias TEXT NOT NULL,
     pin_version INTEGER NOT NULL DEFAULT 0,
     removed INTEGER NOT NULL DEFAULT 0,
     last_seen INTEGER,
     created_at INTEGER NOT NULL
   );`,
];

export interface PostRow {
  id: string;
  column_id: string | null;
  author_ref: string;
  author_name: string;
  created_by: string;
  title: string;
  body: string;
  link: string;
  status: "visible" | "pending" | "hidden";
  created_at: number;
  updated_at: number;
}

export interface AttachmentRow {
  id: string;
  post_id: string;
  position: number;
  drive_file_id: string;
  name: string;
  mime: string;
  size: number;
  kind: "image" | "file";
  width: number | null;
  height: number | null;
  by_ref: string;
  created_at: number;
}

export interface CommentRow {
  id: string;
  post_id: string;
  author_ref: string;
  author_name: string;
  body: string;
  created_at: number;
}

export interface FeedbackRow {
  post_id: string;
  body: string;
  updated_at: number;
}

export interface NoticeRow {
  id: string;
  title: string;
  body: string;
  created_at: number;
  updated_at: number;
}

export interface ColumnRow {
  id: string;
  title: string;
  kind: "topic";
  owner_ref: string | null;
  position: number;
  created_at: number;
}

export interface MemberRow {
  ref: string;
  kind: "roster" | "free";
  number: string;
  name: string;
  nickname: string;
  group_name: string;
  alias: string;
  pin_version: number;
  removed: number;
  last_seen: number | null;
  created_at: number;
}

/** 한 카드를 보여 주는 데 필요한 부속 */
export interface PostParts {
  attachments: AttachmentRow[];
  comments: CommentRow[];
  likers: Set<string>;
  feedback: FeedbackRow | null;
}

/** 스냅숏용 전체 상태 (쓰기 때마다 버리고 필요할 때 다시 읽는 캐시) */
export interface BoardModel {
  posts: PostRow[];
  parts: Map<string, PostParts>;
  notices: NoticeRow[];
  columns: ColumnRow[];
}

type R<T> = T & Record<string, SqlStorageValue>;

export function emptyParts(): PostParts {
  return { attachments: [], comments: [], likers: new Set(), feedback: null };
}

export function getPost(sql: SqlStorage, id: string): PostRow | null {
  return sql.exec<R<PostRow>>("SELECT * FROM posts WHERE id = ?", id).toArray()[0] ?? null;
}

export function loadPostParts(sql: SqlStorage, postId: string): PostParts {
  return {
    attachments: sql.exec<R<AttachmentRow>>("SELECT * FROM attachments WHERE post_id = ? ORDER BY position", postId).toArray(),
    comments: sql.exec<R<CommentRow>>("SELECT * FROM comments WHERE post_id = ? ORDER BY created_at, id", postId).toArray(),
    likers: new Set(sql.exec<{ author_ref: string }>("SELECT author_ref FROM likes WHERE post_id = ?", postId).toArray().map((r) => r.author_ref)),
    feedback: sql.exec<R<FeedbackRow>>("SELECT * FROM feedback WHERE post_id = ?", postId).toArray()[0] ?? null,
  };
}

export function loadModel(sql: SqlStorage): BoardModel {
  const posts = sql.exec<R<PostRow>>("SELECT * FROM posts ORDER BY created_at, id").toArray();
  const parts = new Map<string, PostParts>();
  for (const p of posts) parts.set(p.id, emptyParts());
  for (const a of sql.exec<R<AttachmentRow>>("SELECT * FROM attachments ORDER BY post_id, position")) parts.get(a.post_id)?.attachments.push(a);
  for (const c of sql.exec<R<CommentRow>>("SELECT * FROM comments ORDER BY created_at, id")) parts.get(c.post_id)?.comments.push(c);
  for (const l of sql.exec<{ post_id: string; author_ref: string }>("SELECT post_id, author_ref FROM likes")) parts.get(l.post_id)?.likers.add(l.author_ref);
  for (const f of sql.exec<R<FeedbackRow>>("SELECT * FROM feedback")) {
    const p = parts.get(f.post_id);
    if (p) p.feedback = f;
  }
  return {
    posts,
    parts,
    notices: sql.exec<R<NoticeRow>>("SELECT * FROM notices ORDER BY created_at DESC, id DESC").toArray(),
    columns: loadColumns(sql),
  };
}

export function loadColumns(sql: SqlStorage): ColumnRow[] {
  return sql.exec<R<ColumnRow>>("SELECT * FROM columns ORDER BY position, created_at").toArray();
}

export function loadMembers(sql: SqlStorage): Map<string, MemberRow> {
  const m = new Map<string, MemberRow>();
  for (const r of sql.exec<R<MemberRow>>("SELECT * FROM members")) m.set(r.ref, r);
  return m;
}

export function getMeta<T>(sql: SqlStorage, key: string): T | null {
  const r = sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = ?", key).toArray()[0];
  return r ? (JSON.parse(r.value) as T) : null;
}

export function setMeta(sql: SqlStorage, key: string, value: unknown): void {
  sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", key, JSON.stringify(value));
}

/** 짧은 무작위 별칭 (익명 모드에서 ref 대신) */
export function randomAlias(): string {
  const b = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}
