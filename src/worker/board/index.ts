/**
 * Board Durable Object (보드당 하나, getBoardStub(env, boardId)). 태스크2.
 *
 * - 저장: SQLite (model.ts). 메모리 값은 전부 SQLite 에서 다시 만들 수 있는 캐시뿐 → 언제든 hibernation 가능.
 * - 실시간: WebSocket Hibernation API. 접속자 정보·속도 제한 상태는 serializeAttachment 에 둔다.
 *   "ping" → "pong" 은 setWebSocketAutoResponse 로 DO 를 깨우지 않고 응답.
 * - 가시성: 받는 사람마다 view.ts 로 걸러서 보낸다.
 * - 쓰기 처리 순서: (비동기 준비: id 계산·토큰 검증) → (동기: 확인 + 트랜잭션) → 방송 → ack.
 *   확인과 쓰기 사이에 await 이 없어서 다른 메시지가 끼어들 수 없다 (학생당 1카드 규칙 등).
 * - 백업: 변경 후 30초 알람 → Drive `게시글 백업.json` (태스크3 writeBoardBackup). 실패는 지수 백오프로 재시도.
 */
import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";
import { getSigningSecret, signToken, verifyToken, base64UrlEncode } from "../auth";
import { getRegistry } from "../stubs";
import { applyMigrations } from "../registry/migrations";
import type { RosterMember } from "../registry";
import {
  writeBoardBackup as realWriteBoardBackup, renameBoardFolder as realRenameBoardFolder, DriveError,
  type BoardDriveRpc, type DriveOpts, type DriveState, type DriveStatePatch,
} from "../drive";
import { FILE_VIEW_TOKEN_PURPOSE, UPLOAD_TOKEN_PURPOSE, type FileViewTokenPayload, type UploadedFile } from "../../shared/files";
import {
  CLOSE_CODES, LIMITS, OP_ID_RE,
  type AckResult, type BackupInfo, type BoardSettings, type BoardSettingsPatch, type BoardSnapshot, type ClientMessage,
  type ErrorCode, type PresenceInfo, type ServerMessage,
} from "../../shared/protocol";
import type { BoardActor } from "./actor";
import {
  BOARD_MIGRATIONS, getMeta, getPost, loadColumns, loadMembers, loadModel, loadPostParts, randomAlias, setMeta,
  type AttachmentRow, type BoardModel, type ColumnRow, type CommentRow, type MemberRow, type PostRow,
} from "./model";
import { checkSettingsCombination, DEFAULT_SETTINGS, MIRRORED_KEYS, parseSettingsPatch } from "./settings";
import {
  fail, id as idValue, isPlainObject, line, link as linkValue, rpc, rpcAsync, text, ValidationError, type RpcResult,
} from "./validate";
import {
  canSeePost, columnsView, commentView, isTeacher, meView, noticeView, notSubmitted, postView, publicMemberViews,
  teacherMemberViews, TEACHER_NAME, TEACHER_REF, type Viewer, type ViewCtx,
} from "./view";

export { authenticateBoardActor, type BoardActor } from "./actor";

// ───── 설정값 ─────

export const BACKUP_DELAY_MS = 30_000;
export const BACKUP_RETRY_BASE_MS = 30_000;
export const BACKUP_RETRY_MAX_MS = 30 * 60_000;
/** 이만큼 연달아 실패하면 다음 변경 때까지 쉰다 */
export const BACKUP_MAX_FAILURES = 8;
const FILE_TOKEN_TTL = 12 * 60 * 60;

/** 연결당 토큰 버킷 (메시지 수 제한) */
export const RATE = {
  student: { capacity: 20, perSec: 2 },
  teacher: { capacity: 60, perSec: 6 },
  /** 이만큼 거부당하면 연결을 끊는다 */
  maxStrikes: 60,
} as const;

// ───── Drive 함수 주입 (테스트에서 바꿈) ─────

export interface BoardDriveFns {
  writeBoardBackup(env: Env, boardId: string, content: object, opts?: DriveOpts): Promise<void>;
  renameBoardFolder(env: Env, boardId: string, title: string, opts?: DriveOpts): Promise<void>;
}
const realDriveFns: BoardDriveFns = { writeBoardBackup: realWriteBoardBackup, renameBoardFolder: realRenameBoardFolder };
let driveFns: BoardDriveFns = realDriveFns;
export function setBoardDriveFns(p: Partial<BoardDriveFns>): void {
  driveFns = { ...driveFns, ...p };
}
export function resetBoardDriveFns(): void {
  driveFns = realDriveFns;
}

// ───── 저장 값 모양 ─────

interface Identity {
  id: string;
  code: string;
}

interface DriveMeta {
  folderId?: string;
  attachFolderId?: string;
  backupFileId?: string;
  lastBackupAt?: number;
  backupError?: string;
}

interface BackupMeta {
  lastSuccessAt: number | null;
  lastAttemptAt: number | null;
  failures: number;
  lastError: string | null;
  lastErrorCode: string | null;
  nextAttemptAt: number | null;
  pendingSince: number | null;
}

const EMPTY_BACKUP: BackupMeta = {
  lastSuccessAt: null, lastAttemptAt: null, failures: 0, lastError: null, lastErrorCode: null, nextAttemptAt: null, pendingSince: null,
};

/** 웹소켓마다 붙는 값 (hibernation 뒤에도 남음) */
interface ConnAttachment {
  a: BoardActor;
  /** 토큰 버킷: 남은 토큰, 마지막 갱신(ms), 거부 횟수 */
  tk: number;
  ts: number;
  st: number;
}

/** Worker → DO 웹소켓 요청에 붙이는 헤더 내용 */
export interface ConnectHeader {
  actor: BoardActor;
  /** 명단 학생: Registry 가 확인한 최신 명단 정보 (DO 사본이 늦었으면 고친다) */
  roster?: RosterMember;
}
export const ACTOR_HEADER = "x-nb-connect";

export interface InitBoardInput {
  boardId: string;
  code: string;
  settings: BoardSettings;
}

export interface TeacherBoardDetail {
  settings: BoardSettings;
  backup: BackupInfo;
}

type Handled = AckResult;
type Msg<T extends ClientMessage["t"]> = Extract<ClientMessage, { t: T }>;

async function deriveId(prefix: string, ...parts: string[]): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(parts.join("\n")));
  return prefix + base64UrlEncode(d).slice(0, 16);
}

export class Board extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  // 캐시 (모두 SQLite 에서 다시 만들 수 있음)
  private identityCache: Identity | null | undefined;
  private settingsCache: BoardSettings | null = null;
  private membersCache: Map<string, MemberRow> | null = null;
  private columnsCache: ColumnRow[] | null = null;
  private model: BoardModel | null = null;
  private fileToken: { token: string; exp: number } | null = null;
  /** 최근 처리한 작업 (같은 opId 재전송 → 같은 ack). 잃어도 생성 작업은 결정적 id 로 중복을 막는다 */
  private recentOps = new Map<string, AckResult>();
  private alarmAt: number | null = null;
  private backupRunning = false;
  private dirtyDuringBackup = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => {
      applyMigrations(ctx.storage, BOARD_MIGRATIONS);
    });
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  // ═════════════ 상태 읽기 ═════════════

  private identity(): Identity | null {
    if (this.identityCache === undefined) this.identityCache = getMeta<Identity>(this.sql, "board");
    return this.identityCache;
  }

  private requireIdentity(): Identity {
    return this.identity() ?? fail("not_found", "보드를 찾을 수 없어요.", 404);
  }

  private settings(): BoardSettings {
    if (!this.settingsCache) this.settingsCache = { ...DEFAULT_SETTINGS, ...(getMeta<Partial<BoardSettings>>(this.sql, "settings") ?? {}) };
    return this.settingsCache;
  }

  private members(): Map<string, MemberRow> {
    if (!this.membersCache) this.membersCache = loadMembers(this.sql);
    return this.membersCache;
  }

  private columns(): ColumnRow[] {
    if (!this.columnsCache) this.columnsCache = loadColumns(this.sql);
    return this.columnsCache;
  }

  private getModel(): BoardModel {
    if (!this.model) this.model = loadModel(this.sql);
    return this.model;
  }

  /** 쓰기 뒤 캐시 버림 */
  private dirty(what: { members?: boolean; columns?: boolean; settings?: boolean } = {}): void {
    this.model = null;
    if (what.members) this.membersCache = null;
    if (what.columns) this.columnsCache = null;
    if (what.settings) this.settingsCache = null;
  }

  private viewCtx(viewer: Viewer): ViewCtx {
    return { settings: this.settings(), members: this.members(), topicColumns: this.columns(), viewer };
  }

  private backupMeta(): BackupMeta {
    return { ...EMPTY_BACKUP, ...(getMeta<BackupMeta>(this.sql, "backup") ?? {}) };
  }

  private driveMeta(): DriveMeta {
    return getMeta<DriveMeta>(this.sql, "drive") ?? {};
  }

  // ═════════════ 연결 ═════════════

  private conns(exclude?: WebSocket): Array<{ ws: WebSocket; c: ConnAttachment }> {
    const out: Array<{ ws: WebSocket; c: ConnAttachment }> = [];
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === exclude || ws.readyState !== WebSocket.OPEN) continue;
      const c = ws.deserializeAttachment() as ConnAttachment | null;
      if (c?.a) out.push({ ws, c });
    }
    return out;
  }

  private send(ws: WebSocket, msg: ServerMessage): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // 이미 닫힘
    }
  }

  private closeWhere(pred: (a: BoardActor) => boolean, code: number, reason: string): void {
    for (const { ws, c } of this.conns()) {
      if (!pred(c.a)) continue;
      try {
        ws.close(code, reason);
      } catch {
        // 무시
      }
    }
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/ws") return Response.json({ error: { code: "not_found", message: "찾을 수 없어요." } }, { status: 404 });
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return Response.json({ error: { code: "bad_request", message: "웹소켓 연결이 필요해요." } }, { status: 426 });
    }
    let hdr: ConnectHeader;
    try {
      hdr = JSON.parse(decodeURIComponent(request.headers.get(ACTOR_HEADER) ?? "")) as ConnectHeader;
    } catch {
      return Response.json({ error: { code: "unauthorized", message: "입장이 필요해요." } }, { status: 401 });
    }
    const ident = this.identity();
    const actor = hdr.actor;
    if (!ident || !actor || actor.boardId !== ident.id) {
      return Response.json({ error: { code: "not_found", message: "보드를 찾을 수 없어요." } }, { status: 404 });
    }
    if (actor.role === "student") {
      const s = this.settings();
      if (s.archived) return Response.json({ error: { code: "archived", message: "보관된 보드예요." } }, { status: 403 });
      this.healMember(actor, hdr.roster);
    }

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server, ["r:" + actor.ref.slice(0, 200), actor.role]);
    const cap = RATE[actor.role].capacity;
    server.serializeAttachment({ a: actor, tk: cap, ts: Date.now(), st: 0 } satisfies ConnAttachment);
    this.send(server, { t: "snapshot", snapshot: await this.snapshotFor(actor) });
    this.broadcastPresence();
    return new Response(null, { status: 101, webSocket: client });
  }

  /** 접속한 학생의 구성원 사본이 없거나 늦었으면 고친다 (Registry 가 방금 확인한 값) */
  private healMember(actor: BoardActor, roster: RosterMember | undefined): void {
    const now = Date.now();
    const m = this.members().get(actor.ref);
    if (roster && roster.ref === actor.ref) {
      if (!m || m.removed || m.number !== roster.number || m.name !== roster.name || m.nickname !== roster.nickname || m.group_name !== roster.group || m.pin_version !== roster.pinVersion) {
        this.upsertRosterMember(roster, now);
        this.dirty({ members: true });
        this.afterMemberChange(actor.ref);
      } else if (!m.last_seen || now - m.last_seen > 10 * 60_000) {
        this.sql.exec("UPDATE members SET last_seen = ? WHERE ref = ?", now, actor.ref);
        m.last_seen = now;
      }
      return;
    }
    if (actor.ref.startsWith("f:") && (!m || m.removed)) {
      this.sql.exec(
        `INSERT OR REPLACE INTO members (ref, kind, number, name, nickname, group_name, alias, pin_version, removed, last_seen, created_at)
         VALUES (?, 'free', '', ?, ?, '', ?, 0, 0, ?, ?)`,
        actor.ref, actor.name, actor.name, randomAlias(), now, m?.created_at ?? now,
      );
      this.dirty({ members: true });
      this.afterMemberChange(actor.ref);
    }
  }

  private upsertRosterMember(r: RosterMember, now: number): void {
    const cur = this.members().get(r.ref);
    if (cur) {
      this.sql.exec(
        "UPDATE members SET kind = 'roster', number = ?, name = ?, nickname = ?, group_name = ?, pin_version = ?, removed = 0, last_seen = ? WHERE ref = ?",
        r.number, r.name, r.nickname, r.group, r.pinVersion, now, r.ref,
      );
    } else {
      this.sql.exec(
        `INSERT INTO members (ref, kind, number, name, nickname, group_name, alias, pin_version, removed, last_seen, created_at)
         VALUES (?, 'roster', ?, ?, ?, ?, ?, ?, 0, NULL, ?)`,
        r.ref, r.number, r.name, r.nickname, r.group, randomAlias(), r.pinVersion, now,
      );
    }
  }

  override async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer): Promise<void> {
    const c = ws.deserializeAttachment() as ConnAttachment | null;
    if (!c?.a) {
      ws.close(CLOSE_CODES.reauth, "다시 입장해 주세요.");
      return;
    }
    if (typeof data !== "string") {
      this.send(ws, { t: "error", code: "bad_request", message: "글자(JSON) 메시지만 보낼 수 있어요." });
      return;
    }
    if (data.length > LIMITS.messageBytes || new TextEncoder().encode(data).length > LIMITS.messageBytes) {
      this.send(ws, { t: "error", code: "too_large", message: "보낸 내용이 너무 커요." });
      return;
    }
    let msg: ClientMessage;
    try {
      msg = JSON.parse(data) as ClientMessage;
    } catch {
      this.send(ws, { t: "error", code: "bad_request", message: "메시지 형식이 올바르지 않아요." });
      return;
    }
    if (!isPlainObject(msg) || typeof msg.t !== "string") {
      this.send(ws, { t: "error", code: "bad_request", message: "메시지 형식이 올바르지 않아요." });
      return;
    }

    // 속도 제한 (토큰 버킷, 상태는 attachment 에)
    const rate = RATE[c.a.role];
    const now = Date.now();
    c.tk = Math.min(rate.capacity, c.tk + ((now - c.ts) / 1000) * rate.perSec);
    c.ts = now;
    const cost = msg.t === "sync" ? 5 : 1;
    const opId = "opId" in msg && typeof msg.opId === "string" ? msg.opId : undefined;
    if (c.tk < cost) {
      c.st++;
      ws.serializeAttachment(c);
      if (c.st > RATE.maxStrikes) {
        ws.close(CLOSE_CODES.abuse, "너무 많이 보냈어요.");
        return;
      }
      const wait = Math.ceil(((cost - c.tk) / rate.perSec) * 1000);
      this.send(ws, { t: "error", ...(opId ? { opId } : {}), code: "rate_limited", message: "너무 빨라요. 잠시 뒤에 다시 해 주세요.", retryAfterMs: wait });
      return;
    }
    c.tk -= cost;
    ws.serializeAttachment(c);

    if (msg.t === "sync") {
      this.send(ws, { t: "snapshot", snapshot: await this.snapshotFor(c.a) });
      return;
    }
    if (!opId || !OP_ID_RE.test(opId)) {
      this.send(ws, { t: "error", code: "bad_request", message: "opId 가 필요해요 (8~64자 영문·숫자·-·_)." });
      return;
    }
    const key = `${c.a.ref}|${opId}`;
    const seen = this.recentOps.get(key);
    if (seen) {
      this.send(ws, { t: "ack", opId, result: { ...seen, duplicate: true } });
      return;
    }
    try {
      const result = await this.dispatch(c.a, msg);
      this.remember(key, result);
      this.send(ws, { t: "ack", opId, result });
    } catch (e) {
      if (e instanceof ValidationError) {
        this.send(ws, { t: "error", opId, code: e.code, message: e.message, ...(e.retryAfterMs !== undefined ? { retryAfterMs: e.retryAfterMs } : {}) });
      } else {
        console.error("board op failed", (msg as { t: string }).t, e);
        this.send(ws, { t: "error", opId, code: "internal", message: "잠시 문제가 생겼어요. 다시 시도해 주세요." });
      }
    }
  }

  private remember(key: string, result: AckResult): void {
    this.recentOps.set(key, result);
    if (this.recentOps.size > 2000) {
      const first = this.recentOps.keys().next().value;
      if (first !== undefined) this.recentOps.delete(first);
    }
  }

  override async webSocketClose(ws: WebSocket, code: number, _reason: string, _wasClean: boolean): Promise<void> {
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, "bye");
    } catch {
      // 이미 닫힘
    }
    this.broadcastPresence(ws);
  }

  override async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    this.broadcastPresence(ws);
  }

  // ═════════════ 보내기 ═════════════

  private async currentFileToken(): Promise<{ token: string; exp: number }> {
    const nowSec = Math.floor(Date.now() / 1000);
    if (this.fileToken && this.fileToken.exp - nowSec > 60 * 60) return this.fileToken;
    const ident = this.requireIdentity();
    const payload: FileViewTokenPayload = { boardId: ident.id };
    const token = await signToken(await getSigningSecret(this.env), FILE_VIEW_TOKEN_PURPOSE, payload, FILE_TOKEN_TTL);
    this.fileToken = { token, exp: nowSec + FILE_TOKEN_TTL };
    return this.fileToken;
  }

  private presenceFor(viewer: Viewer, exclude?: WebSocket): PresenceInfo {
    const list = this.conns(exclude);
    const p: PresenceInfo = { count: list.length };
    if (isTeacher(viewer)) p.online = [...new Set(list.map((x) => x.c.a.ref))].sort();
    return p;
  }

  private broadcastPresence(exclude?: WebSocket): void {
    const list = this.conns(exclude);
    const count = list.length;
    const online = [...new Set(list.map((x) => x.c.a.ref))].sort();
    for (const { ws, c } of list) {
      this.send(ws, { t: "presence", presence: c.a.role === "teacher" ? { count, online } : { count } });
    }
  }

  private async snapshotFor(actor: BoardActor): Promise<BoardSnapshot> {
    const ft = await this.currentFileToken();
    return this.buildSnapshot(actor, ft);
  }

  private buildSnapshot(actor: BoardActor, ft: { token: string; exp: number }): BoardSnapshot {
    const ident = this.requireIdentity();
    const model = this.getModel();
    const viewer: Viewer = { role: actor.role, ref: actor.ref };
    const ctx = this.viewCtx(viewer);
    const posts = [];
    for (const p of model.posts) {
      const v = postView(p, model.parts.get(p.id)!, ctx);
      if (v) posts.push(v);
    }
    const snap: BoardSnapshot = {
      board: { id: ident.id, code: ident.code },
      settings: { ...ctx.settings },
      me: meView(ctx, actor.name),
      columns: columnsView(ctx),
      posts,
      notices: model.notices.map(noticeView),
      presence: this.presenceFor(viewer),
      fileToken: ft.token,
      fileTokenExpiresAt: ft.exp * 1000,
      serverTime: Date.now(),
    };
    if (isTeacher(viewer)) {
      snap.roster = teacherMemberViews(ctx.members);
      if (ctx.settings.entryMode === "roster") snap.notSubmitted = notSubmitted(ctx, new Set(model.posts.map((p) => p.author_ref)));
      snap.backup = this.backupStatus();
    } else {
      const m = publicMemberViews(ctx);
      if (m) snap.members = m;
    }
    return snap;
  }

  private async broadcastSnapshot(pred: (a: BoardActor) => boolean = () => true): Promise<void> {
    const ft = await this.currentFileToken();
    for (const { ws, c } of this.conns()) if (pred(c.a)) this.send(ws, { t: "snapshot", snapshot: this.buildSnapshot(c.a, ft) });
  }

  /** 카드 변경 방송: 새로 볼 수 있는 사람에게 upsert, 보다가 못 보게 된 사람에게 remove */
  private broadcastPost(before: PostRow | null, after: PostRow | null, only?: (v: Viewer) => boolean): void {
    const parts = after ? loadPostParts(this.sql, after.id) : null;
    for (const { ws, c } of this.conns()) {
      const viewer: Viewer = { role: c.a.role, ref: c.a.ref };
      if (only && !only(viewer)) continue;
      if (after && canSeePost(after, viewer)) {
        const v = postView(after, parts!, this.viewCtx(viewer));
        if (v) this.send(ws, { t: "post.upsert", post: v });
      } else if (before && canSeePost(before, viewer)) {
        this.send(ws, { t: "post.remove", postId: before.id });
      }
    }
  }

  private broadcastColumns(): void {
    for (const { ws, c } of this.conns()) this.send(ws, { t: "columns.set", columns: columnsView(this.viewCtx({ role: c.a.role, ref: c.a.ref })) });
  }

  private broadcastAll(msg: ServerMessage, pred: (a: BoardActor) => boolean = () => true): void {
    const s = JSON.stringify(msg);
    for (const { ws, c } of this.conns()) {
      if (!pred(c.a)) continue;
      try {
        ws.send(s);
      } catch {
        // 무시
      }
    }
  }

  private broadcastSubmission(): void {
    if (this.settings().entryMode !== "roster") return;
    const teachers = this.conns().filter((x) => x.c.a.role === "teacher");
    if (!teachers.length) return;
    const authors = new Set(this.sql.exec<{ a: string }>("SELECT DISTINCT author_ref AS a FROM posts").toArray().map((r) => r.a));
    const list = notSubmitted({ members: this.members(), settings: this.settings() }, authors);
    for (const { ws } of teachers) this.send(ws, { t: "submission", notSubmitted: list });
  }

  private broadcastBackup(): void {
    this.broadcastAll({ t: "backup.status", backup: this.backupStatus() }, (a) => a.role === "teacher");
  }

  /** 구성원 한 명이 생기거나 이름이 바뀜: 교사·본인은 스냅숏, 다른 학생은 열과 그 사람 카드만 */
  private afterMemberChange(ref: string): void {
    const s = this.settings();
    void this.broadcastSnapshot((a) => a.role === "teacher" || a.ref === ref);
    const others = (a: BoardActor) => a.role === "student" && a.ref !== ref;
    if (s.columnMode === "student" || s.columnMode === "group") {
      for (const { ws, c } of this.conns()) if (others(c.a)) this.send(ws, { t: "columns.set", columns: columnsView(this.viewCtx({ role: c.a.role, ref: c.a.ref })) });
    }
    if (!s.anonymous) {
      const ids = this.sql
        .exec<{ id: string }>("SELECT id FROM posts WHERE author_ref = ? UNION SELECT post_id AS id FROM comments WHERE author_ref = ?", ref, ref)
        .toArray();
      for (const { id } of ids) {
        const p = getPost(this.sql, id);
        if (p) this.broadcastPost(null, p, (v) => v.role === "student" && v.ref !== ref);
      }
    }
  }

  // ═════════════ 작업 처리 ═════════════

  private async dispatch(a: BoardActor, msg: ClientMessage): Promise<Handled> {
    switch (msg.t) {
      case "post.save":
        return this.opPostSave(a, msg);
      case "post.delete":
        return this.opPostDelete(a, msg);
      case "post.moderate":
        return this.opPostModerate(a, msg);
      case "comment.add":
        return this.opCommentAdd(a, msg);
      case "comment.delete":
        return this.opCommentDelete(a, msg);
      case "like.set":
        return this.opLikeSet(a, msg);
      case "feedback.set":
        return this.opFeedback(a, msg);
      case "notice.save":
        return this.opNoticeSave(a, msg);
      case "notice.delete":
        return this.opNoticeDelete(a, msg);
      case "settings.update":
        this.teacherOnly(a);
        await this.applySettings(parseSettingsPatch(msg.patch));
        return {};
      case "column.save":
        return this.opColumnSave(a, msg);
      case "column.delete":
        return this.opColumnDelete(a, msg);
      case "column.reorder":
        return this.opColumnReorder(a, msg);
      default:
        return fail("bad_request", "알 수 없는 메시지예요.");
    }
  }

  private teacherOnly(a: BoardActor): void {
    if (a.role !== "teacher") fail("forbidden", "선생님만 할 수 있어요.", 403);
  }

  /** 쓰기 가능 확인: 보관 → 모두 불가, 잠금 → 학생 불가, 학생은 구성원이어야 함 */
  private assertCanWrite(a: BoardActor): void {
    const s = this.settings();
    if (s.archived) fail("archived", "보관된 보드라서 바꿀 수 없어요.", 403);
    if (a.role === "teacher") return;
    if (s.locked) fail("locked", "선생님이 보드를 잠갔어요. 지금은 볼 수만 있어요.", 403);
    const m = this.members().get(a.ref);
    if (!m || m.removed) fail("forbidden", "이 보드의 구성원이 아니에요. 다시 입장해 주세요.", 403);
  }

  private viewerOf(a: BoardActor): Viewer {
    return { role: a.role, ref: a.ref };
  }

  /** 업로드 확인 토큰 검증 (DESIGN §10) */
  private async verifyUpload(a: BoardActor, token: unknown): Promise<UploadedFile> {
    if (typeof token !== "string") return fail("invalid_upload", "첨부 파일 정보가 올바르지 않아요. 다시 올려 주세요.");
    const f = await verifyToken<UploadedFile>(await getSigningSecret(this.env), UPLOAD_TOKEN_PURPOSE, token);
    const ident = this.requireIdentity();
    if (!f || f.boardId !== ident.id || f.by !== a.ref) return fail("invalid_upload", "첨부 파일 정보가 올바르지 않아요. 다시 올려 주세요.");
    if (typeof f.driveFileId !== "string" || !f.driveFileId || typeof f.name !== "string" || typeof f.size !== "number" || (f.kind !== "image" && f.kind !== "file")) {
      return fail("invalid_upload", "첨부 파일 정보가 올바르지 않아요. 다시 올려 주세요.");
    }
    if (f.size > this.settings().maxFileMB * 1024 * 1024) return fail("too_large", `파일은 ${this.settings().maxFileMB}MB까지 올릴 수 있어요.`, 413);
    return f;
  }

  private async opPostSave(a: BoardActor, msg: Msg<"post.save">): Promise<Handled> {
    const raw = msg.post as unknown;
    if (!isPlainObject(raw)) fail("bad_request", "카드 내용이 올바르지 않아요.");
    const r = raw as Record<string, unknown>;
    this.assertCanWrite(a);
    const title = r.title === undefined ? undefined : line(r.title, LIMITS.postTitle, "제목");
    const body = r.body === undefined ? undefined : text(r.body, LIMITS.postBody, "내용");
    const lnk = r.link === undefined ? undefined : linkValue(r.link, LIMITS.postLink);
    const columnId = r.columnId === undefined || r.columnId === null ? undefined : idValue(r.columnId, "열");
    const editId = r.id === undefined || r.id === null ? null : idValue(r.id, "카드 id");

    // 비동기 준비: 카드 id, 첨부 토큰 검증, 첨부 id
    let authorRef = a.ref;
    if (r.onBehalfOf !== undefined && r.onBehalfOf !== null && !editId) {
      this.teacherOnly(a);
      authorRef = idValue(r.onBehalfOf, "학생");
      const m = this.members().get(authorRef);
      if (!m || m.removed) fail("not_found", "그 학생을 찾을 수 없어요.", 404);
    }
    const postId = editId ?? (await deriveId("p", this.requireIdentity().id, a.ref, msg.opId));
    type Att = { keep: string } | { file: UploadedFile; id: string };
    let atts: Att[] | undefined;
    if (r.attachments !== undefined) {
      if (!Array.isArray(r.attachments)) fail("bad_request", "첨부 목록이 올바르지 않아요.");
      const list = r.attachments as unknown[];
      if (list.length > LIMITS.attachmentsPerPost) fail("limit_reached", `첨부는 카드 하나에 ${LIMITS.attachmentsPerPost}개까지예요.`);
      atts = [];
      for (const item of list) {
        if (!isPlainObject(item)) fail("bad_request", "첨부 목록이 올바르지 않아요.");
        const it = item as Record<string, unknown>;
        if (typeof it.uploadToken === "string") {
          const file = await this.verifyUpload(a, it.uploadToken);
          atts.push({ file, id: await deriveId("a", postId, file.driveFileId) });
        } else {
          atts.push({ keep: idValue(it.id, "첨부") });
        }
      }
    }

    // ── 동기 구간: 확인 + 쓰기 ──
    this.assertCanWrite(a);
    const s = this.settings();
    const now = Date.now();
    const before = getPost(this.sql, postId);

    if (!editId) {
      if (before) {
        if (before.created_by !== a.ref) fail("forbidden", "카드를 저장하지 못했어요.", 403);
        return { postId, duplicate: true };
      }
      if (atts?.some((x) => "keep" in x)) fail("bad_request", "새 카드에는 새로 올린 첨부만 넣을 수 있어요.");
      let col: string | null = null;
      if (s.columnMode === "topic") {
        if (!columnId) fail("column_required", "카드를 놓을 열을 골라 주세요.");
        if (!this.columns().some((c) => c.id === columnId)) fail("not_found", "고른 열이 없어요. 화면을 새로 고쳐 주세요.", 404);
        col = columnId!;
      }
      if (s.type === "single" && authorRef !== TEACHER_REF) {
        if (this.sql.exec("SELECT 1 FROM posts WHERE author_ref = ? LIMIT 1", authorRef).toArray().length) {
          fail("one_card_only", "이 보드는 한 사람이 카드 한 장만 쓸 수 있어요. 이미 쓴 카드를 고쳐 주세요.", 409);
        }
      }
      const count = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM posts").one().n;
      if (count >= LIMITS.postsPerBoard) fail("limit_reached", "이 보드에는 카드를 더 올릴 수 없어요.");
      const files = (atts ?? []).filter((x): x is { file: UploadedFile; id: string } => "file" in x);
      if (!title && !body && !lnk && files.length === 0) fail("empty_post", "제목, 내용, 링크, 첨부 중 하나는 넣어 주세요.");
      const status = a.role === "student" && s.moderation ? "pending" : "visible";
      const member = this.members().get(authorRef);
      const authorName = authorRef === TEACHER_REF ? TEACHER_NAME : (member?.name ?? a.name);
      this.ctx.storage.transactionSync(() => {
        this.sql.exec(
          `INSERT INTO posts (id, column_id, author_ref, author_name, created_by, title, body, link, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          postId, col, authorRef, authorName, a.ref, title ?? "", body ?? "", lnk ?? "", status, now, now,
        );
        this.insertAttachments(postId, files, a.ref, now, 0);
      });
      this.dirty();
      const after = getPost(this.sql, postId)!;
      this.broadcastPost(null, after);
      this.broadcastSubmission();
      await this.ensureBackupAlarm();
      return { postId };
    }

    // 수정
    if (!before) return fail("not_found", "카드를 찾을 수 없어요. 지워졌을 수 있어요.", 404);
    if (a.role !== "teacher" && before.author_ref !== a.ref) fail("forbidden", "내가 쓴 카드만 고칠 수 있어요.", 403);
    const current = this.sql.exec<AttachmentRow & Record<string, SqlStorageValue>>("SELECT * FROM attachments WHERE post_id = ? ORDER BY position", postId).toArray();
    const nextTitle = title ?? before.title;
    const nextBody = body ?? before.body;
    const nextLink = lnk ?? before.link;
    let nextCol = before.column_id;
    if (columnId !== undefined && s.columnMode === "topic") {
      if (!this.columns().some((c) => c.id === columnId)) fail("not_found", "고른 열이 없어요. 화면을 새로 고쳐 주세요.", 404);
      nextCol = columnId;
    }
    let finalCount = current.length;
    if (atts) {
      const curIds = new Set(current.map((x) => x.id));
      for (const x of atts) if ("keep" in x && !curIds.has(x.keep)) fail("not_found", "첨부를 찾을 수 없어요. 화면을 새로 고쳐 주세요.", 404);
      finalCount = new Set(atts.map((x) => ("keep" in x ? x.keep : x.id))).size;
    }
    if (!nextTitle && !nextBody && !nextLink && finalCount === 0) fail("empty_post", "제목, 내용, 링크, 첨부 중 하나는 넣어 주세요.");
    let status = before.status;
    if (a.role === "student" && s.moderation && status === "visible") status = "pending";
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        "UPDATE posts SET title = ?, body = ?, link = ?, column_id = ?, status = ?, updated_at = ? WHERE id = ?",
        nextTitle, nextBody, nextLink, nextCol, status, now, postId,
      );
      if (atts) {
        const keepIds = new Set<string>();
        let pos = 0;
        const seenIds = new Set<string>();
        for (const x of atts) {
          const aid = "keep" in x ? x.keep : x.id;
          if (seenIds.has(aid)) continue;
          seenIds.add(aid);
          if ("keep" in x) {
            keepIds.add(x.keep);
            this.sql.exec("UPDATE attachments SET position = ? WHERE id = ?", pos, x.keep);
          } else if (!current.some((c) => c.id === x.id)) {
            this.insertAttachments(postId, [x], a.ref, now, pos);
            keepIds.add(x.id);
          } else {
            keepIds.add(x.id);
            this.sql.exec("UPDATE attachments SET position = ? WHERE id = ?", pos, x.id);
          }
          pos++;
        }
        for (const c of current) if (!keepIds.has(c.id)) this.sql.exec("DELETE FROM attachments WHERE id = ?", c.id);
      }
    });
    this.dirty();
    this.broadcastPost(before, getPost(this.sql, postId));
    await this.ensureBackupAlarm();
    return { postId };
  }

  private insertAttachments(postId: string, files: Array<{ file: UploadedFile; id: string }>, by: string, now: number, startPos: number): void {
    let pos = startPos;
    for (const { file: f, id } of files) {
      this.sql.exec(
        `INSERT OR IGNORE INTO attachments (id, post_id, position, drive_file_id, name, mime, size, kind, width, height, by_ref, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id, postId, pos++, f.driveFileId, String(f.name).slice(0, 255), String(f.mime || "application/octet-stream").slice(0, 200),
        Math.floor(f.size), f.kind, typeof f.width === "number" ? Math.floor(f.width) : null, typeof f.height === "number" ? Math.floor(f.height) : null,
        by, now,
      );
    }
  }

  private async opPostDelete(a: BoardActor, msg: Msg<"post.delete">): Promise<Handled> {
    const postId = idValue(msg.postId, "카드 id");
    this.assertCanWrite(a);
    const before = getPost(this.sql, postId);
    if (!before) return { postId, duplicate: true };
    if (a.role !== "teacher" && before.author_ref !== a.ref) fail("forbidden", "내가 쓴 카드만 지울 수 있어요.", 403);
    this.deletePostRows(postId);
    this.dirty();
    this.broadcastPost(before, null);
    this.broadcastSubmission();
    await this.ensureBackupAlarm();
    return { postId };
  }

  private deletePostRows(postId: string): void {
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("DELETE FROM posts WHERE id = ?", postId);
      this.sql.exec("DELETE FROM attachments WHERE post_id = ?", postId);
      this.sql.exec("DELETE FROM comments WHERE post_id = ?", postId);
      this.sql.exec("DELETE FROM likes WHERE post_id = ?", postId);
      this.sql.exec("DELETE FROM feedback WHERE post_id = ?", postId);
    });
  }

  private async opPostModerate(a: BoardActor, msg: Msg<"post.moderate">): Promise<Handled> {
    this.teacherOnly(a);
    const postId = idValue(msg.postId, "카드 id");
    const action = msg.action;
    const before = getPost(this.sql, postId) ?? fail("not_found", "카드를 찾을 수 없어요.", 404);
    let status = before.status;
    if (action === "approve") status = before.status === "pending" ? "visible" : before.status;
    else if (action === "hide") status = "hidden";
    else if (action === "unhide") status = before.status === "hidden" ? "visible" : before.status;
    else fail("bad_request", "알 수 없는 동작이에요.");
    if (status === before.status) return { postId };
    this.sql.exec("UPDATE posts SET status = ? WHERE id = ?", status, postId);
    this.dirty();
    this.broadcastPost(before, getPost(this.sql, postId));
    await this.ensureBackupAlarm();
    return { postId };
  }

  private async opCommentAdd(a: BoardActor, msg: Msg<"comment.add">): Promise<Handled> {
    const postId = idValue(msg.postId, "카드 id");
    const body = text(msg.body, LIMITS.commentBody, "댓글", true);
    this.assertCanWrite(a);
    const commentId = await deriveId("c", this.requireIdentity().id, a.ref, msg.opId);
    // 동기 구간
    this.assertCanWrite(a);
    const post = getPost(this.sql, postId);
    if (!post || !canSeePost(post, this.viewerOf(a))) return fail("not_found", "카드를 찾을 수 없어요.", 404);
    if (a.role === "student" && !this.settings().allowComments) fail("comments_disabled", "이 보드는 댓글을 쓸 수 없어요.", 403);
    if (this.sql.exec("SELECT 1 FROM comments WHERE id = ?", commentId).toArray().length) return { postId, commentId, duplicate: true };
    const n = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM comments WHERE post_id = ?", postId).one().n;
    if (n >= LIMITS.commentsPerPost) fail("limit_reached", "이 카드에는 댓글을 더 달 수 없어요.");
    const now = Date.now();
    const authorName = a.role === "teacher" ? TEACHER_NAME : (this.members().get(a.ref)?.name ?? a.name);
    this.sql.exec(
      "INSERT INTO comments (id, post_id, author_ref, author_name, body, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      commentId, postId, a.ref, authorName, body, now,
    );
    this.dirty();
    const row: CommentRow = { id: commentId, post_id: postId, author_ref: a.ref, author_name: authorName, body, created_at: now };
    for (const { ws, c } of this.conns()) {
      const v = this.viewerOf(c.a);
      if (canSeePost(post, v)) this.send(ws, { t: "comment.add", comment: commentView(row, this.viewCtx(v)) });
    }
    await this.ensureBackupAlarm();
    return { postId, commentId };
  }

  private async opCommentDelete(a: BoardActor, msg: Msg<"comment.delete">): Promise<Handled> {
    const postId = idValue(msg.postId, "카드 id");
    const commentId = idValue(msg.commentId, "댓글 id");
    this.assertCanWrite(a);
    const row = this.sql.exec<CommentRow & Record<string, SqlStorageValue>>("SELECT * FROM comments WHERE id = ? AND post_id = ?", commentId, postId).toArray()[0];
    if (!row) return { postId, commentId, duplicate: true };
    if (a.role !== "teacher" && row.author_ref !== a.ref) fail("forbidden", "내가 쓴 댓글만 지울 수 있어요.", 403);
    this.sql.exec("DELETE FROM comments WHERE id = ?", commentId);
    this.dirty();
    const post = getPost(this.sql, postId);
    for (const { ws, c } of this.conns()) {
      if (!post || canSeePost(post, this.viewerOf(c.a))) this.send(ws, { t: "comment.remove", postId, commentId });
    }
    await this.ensureBackupAlarm();
    return { postId, commentId };
  }

  private async opLikeSet(a: BoardActor, msg: Msg<"like.set">): Promise<Handled> {
    const postId = idValue(msg.postId, "카드 id");
    if (typeof msg.liked !== "boolean") fail("bad_request", "좋아요 값이 올바르지 않아요.");
    this.assertCanWrite(a);
    const post = getPost(this.sql, postId);
    if (!post || !canSeePost(post, this.viewerOf(a))) return fail("not_found", "카드를 찾을 수 없어요.", 404);
    if (a.role === "student" && !this.settings().allowLikes) fail("likes_disabled", "이 보드는 좋아요를 누를 수 없어요.", 403);
    const has = this.sql.exec("SELECT 1 FROM likes WHERE post_id = ? AND author_ref = ?", postId, a.ref).toArray().length > 0;
    if (has === msg.liked) return { postId };
    if (msg.liked) this.sql.exec("INSERT OR IGNORE INTO likes (post_id, author_ref) VALUES (?, ?)", postId, a.ref);
    else this.sql.exec("DELETE FROM likes WHERE post_id = ? AND author_ref = ?", postId, a.ref);
    this.dirty();
    const likers = new Set(this.sql.exec<{ r: string }>("SELECT author_ref AS r FROM likes WHERE post_id = ?", postId).toArray().map((x) => x.r));
    for (const { ws, c } of this.conns()) {
      if (canSeePost(post, this.viewerOf(c.a))) this.send(ws, { t: "like.set", postId, count: likers.size, liked: likers.has(c.a.ref) });
    }
    await this.ensureBackupAlarm();
    return { postId };
  }

  private async opFeedback(a: BoardActor, msg: Msg<"feedback.set">): Promise<Handled> {
    this.teacherOnly(a);
    const postId = idValue(msg.postId, "카드 id");
    const body = text(msg.body, LIMITS.feedbackBody, "피드백");
    const post = getPost(this.sql, postId) ?? fail("not_found", "카드를 찾을 수 없어요.", 404);
    if (body) this.sql.exec("INSERT OR REPLACE INTO feedback (post_id, body, updated_at) VALUES (?, ?, ?)", postId, body, Date.now());
    else this.sql.exec("DELETE FROM feedback WHERE post_id = ?", postId);
    this.dirty();
    // 피드백은 작성자와 교사에게만
    this.broadcastPost(post, post, (v) => isTeacher(v) || v.ref === post.author_ref);
    await this.ensureBackupAlarm();
    return { postId };
  }

  private async opNoticeSave(a: BoardActor, msg: Msg<"notice.save">): Promise<Handled> {
    this.teacherOnly(a);
    const raw = msg.notice as unknown;
    if (!isPlainObject(raw)) fail("bad_request", "공지 내용이 올바르지 않아요.");
    const r = raw as Record<string, unknown>;
    const title = line(r.title, LIMITS.noticeTitle, "공지 제목", true);
    const body = text(r.body, LIMITS.noticeBody, "공지 내용");
    const now = Date.now();
    let noticeId: string;
    if (r.id !== undefined && r.id !== null) {
      noticeId = idValue(r.id, "공지 id");
      if (!this.sql.exec("SELECT 1 FROM notices WHERE id = ?", noticeId).toArray().length) fail("not_found", "공지를 찾을 수 없어요.", 404);
      this.sql.exec("UPDATE notices SET title = ?, body = ?, updated_at = ? WHERE id = ?", title, body, now, noticeId);
    } else {
      noticeId = await deriveId("n", this.requireIdentity().id, a.ref, msg.opId);
      if (this.sql.exec("SELECT 1 FROM notices WHERE id = ?", noticeId).toArray().length) return { noticeId, duplicate: true };
      const n = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM notices").one().n;
      if (n >= LIMITS.noticesPerBoard) fail("limit_reached", `공지는 ${LIMITS.noticesPerBoard}개까지 둘 수 있어요.`);
      this.sql.exec("INSERT INTO notices (id, title, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?)", noticeId, title, body, now, now);
    }
    this.dirty();
    const row = this.sql.exec<{ id: string; title: string; body: string; created_at: number; updated_at: number }>("SELECT * FROM notices WHERE id = ?", noticeId).one();
    this.broadcastAll({ t: "notice.upsert", notice: noticeView(row) });
    await this.ensureBackupAlarm();
    return { noticeId };
  }

  private async opNoticeDelete(a: BoardActor, msg: Msg<"notice.delete">): Promise<Handled> {
    this.teacherOnly(a);
    const noticeId = idValue(msg.noticeId, "공지 id");
    if (!this.sql.exec("SELECT 1 FROM notices WHERE id = ?", noticeId).toArray().length) return { noticeId, duplicate: true };
    this.sql.exec("DELETE FROM notices WHERE id = ?", noticeId);
    this.dirty();
    this.broadcastAll({ t: "notice.remove", noticeId });
    await this.ensureBackupAlarm();
    return { noticeId };
  }

  private requireTopicMode(): void {
    if (this.settings().columnMode !== "topic") fail("invalid_settings", "주제별 열 구성에서만 열을 고칠 수 있어요.");
  }

  private async opColumnSave(a: BoardActor, msg: Msg<"column.save">): Promise<Handled> {
    this.teacherOnly(a);
    this.requireTopicMode();
    const raw = msg.column as unknown;
    if (!isPlainObject(raw)) fail("bad_request", "열 내용이 올바르지 않아요.");
    const r = raw as Record<string, unknown>;
    const title = line(r.title, LIMITS.columnTitle, "열 이름", true);
    let columnId: string;
    if (r.id !== undefined && r.id !== null) {
      columnId = idValue(r.id, "열 id");
      if (!this.columns().some((c) => c.id === columnId)) fail("not_found", "열을 찾을 수 없어요.", 404);
      this.sql.exec("UPDATE columns SET title = ? WHERE id = ?", title, columnId);
    } else {
      columnId = await deriveId("k", this.requireIdentity().id, a.ref, msg.opId);
      if (this.sql.exec("SELECT 1 FROM columns WHERE id = ?", columnId).toArray().length) return { columnId, duplicate: true };
      if (this.columns().length >= LIMITS.columnsPerBoard) fail("limit_reached", `열은 ${LIMITS.columnsPerBoard}개까지 만들 수 있어요.`);
      this.insertColumn(columnId, title);
    }
    this.dirty({ columns: true });
    this.broadcastColumns();
    await this.ensureBackupAlarm();
    return { columnId };
  }

  private insertColumn(id: string, title: string): void {
    const max = this.sql.exec<{ m: number | null }>("SELECT MAX(position) AS m FROM columns").one().m;
    this.sql.exec("INSERT INTO columns (id, title, kind, owner_ref, position, created_at) VALUES (?, ?, 'topic', NULL, ?, ?)", id, title, (max ?? -1) + 1, Date.now());
    this.columnsCache = null;
  }

  private async opColumnDelete(a: BoardActor, msg: Msg<"column.delete">): Promise<Handled> {
    this.teacherOnly(a);
    this.requireTopicMode();
    const columnId = idValue(msg.columnId, "열 id");
    if (!this.columns().some((c) => c.id === columnId)) return { columnId, duplicate: true };
    if (this.columns().length <= 1) fail("limit_reached", "열은 하나 이상 있어야 해요.");
    if (this.sql.exec("SELECT 1 FROM posts WHERE column_id = ? LIMIT 1", columnId).toArray().length) {
      fail("column_not_empty", "카드가 있는 열은 지울 수 없어요. 카드를 먼저 옮기거나 지워 주세요.", 409);
    }
    this.sql.exec("DELETE FROM columns WHERE id = ?", columnId);
    this.dirty({ columns: true });
    this.broadcastColumns();
    await this.ensureBackupAlarm();
    return { columnId };
  }

  private async opColumnReorder(a: BoardActor, msg: Msg<"column.reorder">): Promise<Handled> {
    this.teacherOnly(a);
    this.requireTopicMode();
    if (!Array.isArray(msg.order)) fail("bad_request", "열 순서가 올바르지 않아요.");
    const order = (msg.order as unknown[]).map((x) => idValue(x, "열 id"));
    const ids = this.columns().map((c) => c.id);
    if (order.length !== ids.length || new Set(order).size !== order.length || order.some((x) => !ids.includes(x))) {
      fail("bad_request", "열 순서가 올바르지 않아요. 화면을 새로 고쳐 주세요.");
    }
    this.ctx.storage.transactionSync(() => {
      order.forEach((cid, i) => this.sql.exec("UPDATE columns SET position = ? WHERE id = ?", i, cid));
    });
    this.dirty({ columns: true });
    this.broadcastColumns();
    await this.ensureBackupAlarm();
    return {};
  }

  // ═════════════ 설정 ═════════════

  /** 카드 상태와 맞지 않는 설정 거부 */
  private checkAgainstState(next: BoardSettings, cur: BoardSettings): void {
    checkSettingsCombination(next);
    if (next.type === "single" && cur.type !== "single") {
      const dup = this.sql.exec("SELECT author_ref FROM posts WHERE author_ref != ? GROUP BY author_ref HAVING COUNT(*) > 1 LIMIT 1", TEACHER_REF).toArray();
      if (dup.length) fail("invalid_settings", "카드를 여러 장 쓴 학생이 있어서 '학생당 카드 1장'으로 바꿀 수 없어요.");
    }
  }

  private async applySettings(patch: BoardSettingsPatch): Promise<BoardSettings> {
    const ident = this.requireIdentity();
    const cur = this.settings();
    if (cur.archived) fail("archived", "보관된 보드는 설정을 바꿀 수 없어요. 먼저 보관을 풀어 주세요.", 403);
    let next: BoardSettings = { ...cur, ...patch };
    this.checkAgainstState(next, cur);
    const mirrored: Record<string, unknown> = {};
    for (const k of MIRRORED_KEYS) if (next[k] !== cur[k]) mirrored[k] = next[k];
    if (Object.keys(mirrored).length) {
      const r = await getRegistry(this.env).updateBoardMeta(ident.id, mirrored);
      if (!r.ok) fail(r.code, r.message, r.status);
      else if (!r.value) fail("not_found", "보드를 찾을 수 없어요.", 404);
    }
    // await 뒤: 다시 읽고 다시 확인 (그 사이 다른 쓰기)
    const cur2 = this.settings();
    next = { ...cur2, ...patch };
    this.checkAgainstState(next, cur2);
    this.commitSettings(next);
    this.afterSettingsChange(cur2, next);
    await this.ensureBackupAlarm();
    return next;
  }

  private commitSettings(next: BoardSettings): void {
    const prev = this.settings();
    this.ctx.storage.transactionSync(() => {
      setMeta(this.sql, "settings", next);
      if (next.anonymous && !prev.anonymous) {
        // 익명을 켤 때마다 별칭을 새로 (예전에 본 ref↔별칭 대응을 못 쓰게)
        for (const m of this.sql.exec<{ ref: string }>("SELECT ref FROM members").toArray()) {
          this.sql.exec("UPDATE members SET alias = ? WHERE ref = ?", randomAlias(), m.ref);
        }
      }
      if (next.columnMode === "topic") {
        if (!loadColumns(this.sql).length) {
          this.sql.exec(
            "INSERT INTO columns (id, title, kind, owner_ref, position, created_at) VALUES (?, ?, 'topic', NULL, 0, ?)",
            "k" + base64UrlEncode(crypto.getRandomValues(new Uint8Array(9))), "주제 1", Date.now(),
          );
        }
        const first = loadColumns(this.sql)[0]!.id;
        this.sql.exec("UPDATE posts SET column_id = ? WHERE column_id IS NULL OR column_id NOT IN (SELECT id FROM columns)", first);
      }
    });
    this.settingsCache = next;
    this.dirty({ members: true, columns: true });
  }

  private afterSettingsChange(prev: BoardSettings, next: BoardSettings): void {
    const ident = this.requireIdentity();
    if (next.entryMode !== prev.entryMode) {
      // 다른 입장 방식의 학생 토큰은 이제 무효
      this.closeWhere((a) => a.role === "student", CLOSE_CODES.reauth, "입장 방식이 바뀌었어요.");
    }
    if (next.anonymous !== prev.anonymous || next.columnMode !== prev.columnMode || next.entryMode !== prev.entryMode) {
      void this.broadcastSnapshot();
    } else {
      this.broadcastAll({ t: "settings.update", settings: next });
    }
    if (next.title !== prev.title) {
      this.ctx.waitUntil(
        driveFns.renameBoardFolder(this.env, ident.id, next.title, { state: this.getDriveState(), board: this.localDriveRpc() }).catch((e) => {
          console.warn("renameBoardFolder failed", e);
        }),
      );
    }
  }

  // ═════════════ RPC: Worker 라우트용 ═════════════

  /** 보드 만들 때 한 번 (같은 값으로 다시 불러도 됨) */
  init(input: InitBoardInput): RpcResult<BoardSettings> {
    return rpc(() => {
      const cur = this.identity();
      if (cur && cur.id !== input.boardId) fail("bad_request", "다른 보드예요.");
      const settings: BoardSettings = { ...DEFAULT_SETTINGS, ...input.settings };
      checkSettingsCombination(settings);
      setMeta(this.sql, "board", { id: input.boardId, code: input.code } satisfies Identity);
      this.identityCache = { id: input.boardId, code: input.code };
      this.settingsCache = null;
      this.commitSettings(settings);
      return settings;
    });
  }

  getTeacherDetail(): TeacherBoardDetail | null {
    if (!this.identity()) return null;
    return { settings: this.settings(), backup: this.backupStatus() };
  }

  async updateSettings(patch: unknown): Promise<RpcResult<BoardSettings>> {
    return rpcAsync(() => this.applySettings(parseSettingsPatch(patch)));
  }

  async setArchived(archived: boolean): Promise<RpcResult<BoardSettings>> {
    return rpcAsync(async () => {
      const ident = this.requireIdentity();
      const r = await getRegistry(this.env).updateBoardMeta(ident.id, { archived });
      if (!r.ok) fail(r.code, r.message, r.status);
      const next: BoardSettings = { ...this.settings(), archived };
      setMeta(this.sql, "settings", next);
      this.settingsCache = next;
      if (archived) this.closeWhere((a) => a.role === "student", CLOSE_CODES.archived, "보관된 보드예요.");
      this.broadcastAll({ t: "settings.update", settings: next });
      await this.ensureBackupAlarm();
      return next;
    });
  }

  /** 보드 삭제: 모든 연결 끊고 저장소 비움 (Drive 폴더는 남는다) */
  async destroy(): Promise<void> {
    this.closeWhere(() => true, CLOSE_CODES.deleted, "보드가 지워졌어요.");
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    this.identityCache = undefined;
    this.settingsCache = this.membersCache = this.columnsCache = this.model = null;
    this.alarmAt = null;
    this.recentOps.clear();
  }

  /** Registry 명단 사본 갱신 (반 연결·명단 수정 때 Worker 가 부름). 바뀐 게 있으면 모두에게 스냅숏 */
  async setRoster(list: RosterMember[]): Promise<{ changed: number }> {
    if (!this.identity()) return { changed: 0 };
    const now = Date.now();
    const members = this.members();
    const incoming = new Map(list.map((m) => [m.ref, m]));
    const kick: string[] = [];
    let changed = 0;
    this.ctx.storage.transactionSync(() => {
      for (const r of list) {
        const m = members.get(r.ref);
        if (m && !m.removed && m.kind === "roster" && m.number === r.number && m.name === r.name && m.nickname === r.nickname && m.group_name === r.group && m.pin_version === r.pinVersion) continue;
        if (m && m.pin_version !== r.pinVersion) kick.push(r.ref);
        this.upsertRosterMember(r, now);
        changed++;
      }
      for (const m of members.values()) {
        if (m.kind === "roster" && !m.removed && !incoming.has(m.ref)) {
          this.sql.exec("UPDATE members SET removed = 1 WHERE ref = ?", m.ref);
          kick.push(m.ref);
          changed++;
        }
      }
    });
    if (!changed) return { changed };
    this.dirty({ members: true });
    const kicked = new Set(kick);
    this.closeWhere((a) => kicked.has(a.ref), CLOSE_CODES.reauth, "다시 입장해 주세요.");
    await this.broadcastSnapshot((a) => !kicked.has(a.ref));
    return { changed };
  }

  /** 자유 입장 */
  joinFree(input: { ref: string; nickname: string }): RpcResult<{ ref: string; nickname: string }> {
    return rpc(() => {
      this.requireIdentity();
      const s = this.settings();
      if (s.archived) fail("archived", "보관된 보드예요. 선생님께 여쭤 보세요.", 403);
      if (s.entryMode !== "free") fail("wrong_entry_mode", "이 보드는 학번과 PIN으로 들어가요.");
      const m = this.members().get(input.ref);
      const now = Date.now();
      if (!m) {
        const n = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM members WHERE kind = 'free'").one().n;
        if (n >= LIMITS.freeMembersPerBoard) fail("limit_reached", "이 보드에는 더 들어올 수 없어요. 선생님께 여쭤 보세요.");
        this.sql.exec(
          `INSERT INTO members (ref, kind, number, name, nickname, group_name, alias, pin_version, removed, last_seen, created_at)
           VALUES (?, 'free', '', ?, ?, '', ?, 0, 0, ?, ?)`,
          input.ref, input.nickname, input.nickname, randomAlias(), now, now,
        );
      } else if (m.name !== input.nickname || m.nickname !== input.nickname || m.removed) {
        this.sql.exec("UPDATE members SET name = ?, nickname = ?, removed = 0, last_seen = ? WHERE ref = ?", input.nickname, input.nickname, now, input.ref);
      } else {
        return { ref: input.ref, nickname: input.nickname };
      }
      this.dirty({ members: true });
      this.afterMemberChange(input.ref);
      return { ref: input.ref, nickname: input.nickname };
    });
  }

  /** 자유 입장 학생 닉네임 변경 */
  setFreeNickname(ref: string, nickname: string): RpcResult<{ ref: string; nickname: string }> {
    return rpc(() => {
      const m = this.members().get(ref);
      if (!m || m.kind !== "free" || m.removed) fail("unauthorized", "다시 입장해 주세요.", 401);
      if (this.settings().locked) fail("locked", "선생님이 보드를 잠갔어요.", 403);
      if (m!.nickname === nickname) return { ref, nickname };
      this.sql.exec("UPDATE members SET name = ?, nickname = ? WHERE ref = ?", nickname, nickname, ref);
      this.dirty({ members: true });
      this.afterMemberChange(ref);
      // 이 학생 연결의 actor.name 도 바꿔 둔다
      for (const { ws, c } of this.conns()) {
        if (c.a.ref === ref) {
          c.a = { ...c.a, name: nickname };
          ws.serializeAttachment(c);
        }
      }
      return { ref, nickname };
    });
  }

  /** 포트폴리오: 한 학생의 카드 (교사 보기, 모든 상태) */
  portfolioFor(ref: string) {
    const ctx = this.viewCtx({ role: "teacher", ref: TEACHER_REF });
    const rows = this.sql.exec<PostRow & Record<string, SqlStorageValue>>("SELECT * FROM posts WHERE author_ref = ? ORDER BY created_at", ref).toArray();
    return rows.map((p) => postView(p, loadPostParts(this.sql, p.id), ctx)!).filter(Boolean);
  }

  // ═════════════ RPC: DESIGN §10 (태스크3용) ═════════════

  getUploadPolicy(actor: BoardActor): { ok: true; maxBytes: number } | { ok: false; reason: string } {
    const ident = this.identity();
    if (!ident || actor.boardId !== ident.id) return { ok: false, reason: "보드를 찾을 수 없어요." };
    const s = this.settings();
    if (s.archived) return { ok: false, reason: "보관된 보드라서 올릴 수 없어요." };
    if (actor.role === "student") {
      if (s.locked) return { ok: false, reason: "선생님이 보드를 잠갔어요. 지금은 올릴 수 없어요." };
      const m = this.members().get(actor.ref);
      if (!m || m.removed) return { ok: false, reason: "이 보드의 구성원이 아니에요. 다시 입장해 주세요." };
    } else if (actor.role !== "teacher") {
      return { ok: false, reason: "올릴 권한이 없어요." };
    }
    return { ok: true, maxBytes: s.maxFileMB * 1024 * 1024 };
  }

  getAttachment(attachmentId: string): { driveFileId: string; name: string; mime: string; size: number; kind: "image" | "file" } | null {
    const r = this.sql.exec<AttachmentRow & Record<string, SqlStorageValue>>("SELECT * FROM attachments WHERE id = ?", String(attachmentId)).toArray()[0];
    return r ? { driveFileId: r.drive_file_id, name: r.name, mime: r.mime, size: r.size, kind: r.kind } : null;
  }

  getDriveState(): DriveState {
    const ident = this.identity();
    const d = this.driveMeta();
    const b = this.backupMeta();
    return {
      folderId: d.folderId ?? null,
      attachFolderId: d.attachFolderId ?? null,
      backupFileId: d.backupFileId ?? null,
      title: this.settings().title,
      code: ident?.code ?? "",
      lastBackupAt: d.lastBackupAt ?? b.lastSuccessAt ?? null,
      backupError: b.failures > 0 ? b.lastError : (d.backupError ?? null),
      backupPending: b.pendingSince !== null,
    };
  }

  /** patch 의 null 은 "지움". backupPending 은 이 DO 가 알람으로 관리하므로 무시 */
  async setDriveState(patch: DriveStatePatch): Promise<void> {
    const d = this.driveMeta() as Record<string, unknown>;
    const before = d.folderId;
    for (const k of ["folderId", "attachFolderId", "backupFileId", "lastBackupAt", "backupError"] as const) {
      if (!(k in patch)) continue;
      const v = patch[k];
      if (v === null || v === undefined) delete d[k];
      else d[k] = v;
    }
    setMeta(this.sql, "drive", d);
    const ident = this.identity();
    if (ident && d.folderId !== before) {
      try {
        await getRegistry(this.env).setBoardDriveFolder(ident.id, (d.folderId as string | undefined) ?? null);
      } catch (e) {
        console.warn("setBoardDriveFolder failed", e);
      }
    }
  }

  exportRows(): { header: string[]; rows: string[][] } {
    const ctx = this.viewCtx({ role: "teacher", ref: TEACHER_REF });
    const cols = new Map(columnsView(ctx).map((c) => [c.id, c.title]));
    const model = this.getModel();
    const header = ["열", "학번", "이름", "닉네임", "제목", "내용", "링크", "첨부", "상태", "좋아요", "댓글", "피드백", "작성 시각", "수정 시각"];
    const statusKo = { visible: "게시", pending: "승인 대기", hidden: "숨김" } as const;
    const fmt = (t: number) => new Date(t + 9 * 3600_000).toISOString().slice(0, 16).replace("T", " ");
    const rows = model.posts.map((p) => {
      const parts = model.parts.get(p.id)!;
      const v = postView(p, parts, ctx)!;
      const m = ctx.members.get(p.author_ref);
      return [
        (v.columnId && cols.get(v.columnId)) || "",
        m?.number ?? "",
        v.authorName,
        m?.nickname ?? "",
        p.title,
        p.body,
        p.link,
        parts.attachments.map((a) => a.name).join(", "),
        statusKo[p.status],
        String(parts.likers.size),
        parts.comments.map((c) => `${commentView(c, ctx).authorName}: ${c.body}`).join("\n"),
        parts.feedback?.body ?? "",
        fmt(p.created_at),
        fmt(p.updated_at),
      ];
    });
    return { header, rows };
  }

  /** writeBoardBackup 등에 넘길, 자기 자신을 RPC 없이 부르는 객체 */
  private localDriveRpc(): BoardDriveRpc {
    return {
      getUploadPolicy: (a) => this.getUploadPolicy(a),
      getAttachment: (id) => this.getAttachment(id),
      getDriveState: () => this.getDriveState(),
      setDriveState: (p) => this.setDriveState(p),
      exportRows: () => this.exportRows(),
    };
  }

  // ═════════════ 백업 알람 ═════════════

  backupStatus(): BackupInfo {
    const b = this.backupMeta();
    let state: BackupInfo["state"];
    if (b.failures > 0) state = b.lastErrorCode === "reconnect" || b.lastErrorCode === "not_configured" ? "unavailable" : "error";
    else if (b.pendingSince !== null) state = "pending";
    else if (b.lastSuccessAt !== null) state = "ok";
    else state = "never";
    return {
      state,
      lastSuccessAt: b.lastSuccessAt,
      lastAttemptAt: b.lastAttemptAt,
      failures: b.failures,
      lastError: b.lastError,
      nextAttemptAt: b.nextAttemptAt,
    };
  }

  /** 변경이 생겼음: 알람이 없으면 30초 뒤로 건다 (그 사이 변경은 한 번에 백업 — 디바운스) */
  private async ensureBackupAlarm(): Promise<void> {
    if (this.backupRunning) {
      this.dirtyDuringBackup = true;
      return;
    }
    const now = Date.now();
    if (this.alarmAt !== null && this.alarmAt > now - 5_000) return;
    const existing = await this.ctx.storage.getAlarm();
    if (existing !== null) {
      this.alarmAt = existing;
      return;
    }
    const at = now + BACKUP_DELAY_MS;
    await this.ctx.storage.setAlarm(at);
    this.alarmAt = at;
    const b = this.backupMeta();
    if (b.pendingSince === null) {
      b.pendingSince = now;
      b.nextAttemptAt = at;
      setMeta(this.sql, "backup", b);
      this.broadcastBackup();
    }
  }

  /** 백업 파일 내용 */
  backupContent(): object {
    const ident = this.requireIdentity();
    const ctx = this.viewCtx({ role: "teacher", ref: TEACHER_REF });
    const model = this.getModel();
    return {
      format: "nanumboard-backup",
      version: 1,
      exportedAt: new Date().toISOString(),
      board: { id: ident.id, code: ident.code, settings: ctx.settings },
      columns: columnsView(ctx),
      members: teacherMemberViews(ctx.members),
      notices: model.notices.map(noticeView),
      posts: model.posts.map((p) => {
        const parts = model.parts.get(p.id)!;
        const v = postView(p, parts, ctx)!;
        return { ...v, attachments: parts.attachments.map((a) => ({ ...v.attachments.find((x) => x.id === a.id), driveFileId: a.drive_file_id })) };
      }),
    };
  }

  private boardStats() {
    const model = this.getModel();
    const ctx = this.viewCtx({ role: "teacher", ref: TEACHER_REF });
    const recent = [...model.posts]
      .sort((a, b) => b.created_at - a.created_at)
      .slice(0, 12)
      .map((p) => {
        const parts = model.parts.get(p.id)!;
        const v = postView(p, parts, ctx)!;
        return {
          postId: p.id,
          authorName: v.authorName,
          ...(v.authorNumber ? { authorNumber: v.authorNumber } : {}),
          title: p.title,
          excerpt: p.body.slice(0, 200),
          status: p.status,
          hasImage: parts.attachments.some((a) => a.kind === "image"),
          createdAt: p.created_at,
        };
      });
    return {
      postCount: model.posts.length,
      lastPostAt: model.posts.reduce<number | null>((m, p) => (m === null || p.created_at > m ? p.created_at : m), null),
      recent,
    };
  }

  override async alarm(): Promise<void> {
    this.alarmAt = null;
    const ident = this.identity();
    if (!ident) return;
    this.backupRunning = true;
    this.dirtyDuringBackup = false;
    try {
      // 교사 대시보드용 통계 (Drive 와 무관하게)
      try {
        await getRegistry(this.env).updateBoardStats(ident.id, this.boardStats());
      } catch (e) {
        console.warn("updateBoardStats failed", e);
      }
      const now = Date.now();
      const b = this.backupMeta();
      b.lastAttemptAt = now;
      try {
        await driveFns.writeBoardBackup(this.env, ident.id, this.backupContent(), { state: this.getDriveState(), board: this.localDriveRpc() });
        b.failures = 0;
        b.lastError = null;
        b.lastErrorCode = null;
        b.lastSuccessAt = Date.now();
        b.nextAttemptAt = null;
        b.pendingSince = null;
      } catch (e) {
        b.failures++;
        b.lastError = e instanceof DriveError ? e.message : "백업하지 못했어요. 잠시 후 다시 시도할게요.";
        b.lastErrorCode = e instanceof DriveError ? e.code : "unknown";
        if (!(e instanceof DriveError)) console.warn("backup failed", e);
        if (b.failures < BACKUP_MAX_FAILURES) {
          const delay = Math.min(BACKUP_RETRY_MAX_MS, BACKUP_RETRY_BASE_MS * 2 ** (b.failures - 1));
          const at = Date.now() + delay;
          await this.ctx.storage.setAlarm(at);
          this.alarmAt = at;
          b.nextAttemptAt = at;
        } else {
          // 쉰다: 다음 변경이 생기면 다시 시도
          b.nextAttemptAt = null;
          b.pendingSince = null;
        }
      }
      setMeta(this.sql, "backup", b);
      this.broadcastBackup();
    } finally {
      this.backupRunning = false;
      if (this.dirtyDuringBackup && this.alarmAt === null) await this.ensureBackupAlarm();
    }
  }

  // 테스트·진단용
  debugCounts(): { posts: number; members: number; sockets: number } {
    return {
      posts: this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM posts").one().n,
      members: this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM members WHERE removed = 0").one().n,
      sockets: this.ctx.getWebSockets().length,
    };
  }
}

