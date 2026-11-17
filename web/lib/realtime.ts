/**
 * 보드 웹소켓 클라이언트 + 상태 저장소 (프레임워크 없음). 계약: docs/PROTOCOL.md §2·§7.
 *
 *   const conn = new BoardConnection({ code, getToken: () => token, onToast: showToast });
 *   conn.subscribe(() => render(conn.getState()));
 *   conn.connect();
 *   conn.send({ t: "like.set", postId, liked: true });   // 낙관적 반영 → ack 로 확정, error 면 되돌리고 토스트
 *
 * 계산은 realtime-state.ts 의 순수 함수가 한다. 이 파일은 연결·재접속·핑·대기열만 맡는다.
 */
import { CLOSE_CODES, OP_ID_RE, type AckResult, type BoardSnapshot, type ErrorCode, type ServerMessage } from "../../src/shared/protocol";
import {
  applyServerMessage,
  backoffDelay,
  derive,
  fromSnapshot,
  matchCreates,
  settle,
  type PendingOp,
  type ServerState,
  type ViewAttachment,
  type WriteMessage,
} from "./realtime-state";

export * from "./realtime-state";

export type ConnStatus =
  /** 처음 연결 중 (아직 스냅숏 없음) */
  | "connecting"
  /** 연결됨 */
  | "open"
  /** 끊겨서 다시 연결하는 중 */
  | "reconnecting"
  /** 기기가 오프라인 */
  | "offline"
  /** 다시 연결하지 않음 (closedReason 참고) */
  | "closed";

export type ClosedReason = "reauth" | "archived" | "deleted" | "unauthorized" | "not_found";

export interface ConnState {
  status: ConnStatus;
  closedReason: ClosedReason | null;
  /** 스냅숏을 받기 전에는 null */
  view: ServerState | null;
  /** 아직 서버 확인을 못 받은 쓰기 수 */
  pendingCount: number;
}

type Payload = WriteMessage extends infer M ? (M extends { opId: string } ? Omit<M, "opId"> : never) : never;

export class OpError extends Error {
  constructor(
    readonly code: ErrorCode | "closed",
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "OpError";
  }
}

export interface WebSocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason?: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export interface ConnectionOptions {
  code: string;
  /** 학생 토큰 (없으면 교사 쿠키로 접속) */
  getToken: () => string | null;
  /** 실패 안내 (한국어) */
  onToast?: (message: string) => void;
  /** 핸드셰이크가 계속 실패할 때 원인 확인 (예: 학생 GET /me). 재접속하면 안 되는 이유면 돌려준다 */
  diagnose?: () => Promise<ClosedReason | null>;
  /** 시험용 */
  createSocket?: (url: string) => WebSocketLike;
  /** 시험용: 브라우저 이벤트(online/visibility)를 붙이지 않음 */
  headless?: boolean;
}

const PING_EVERY_MS = 40_000;
/** 핑 뒤 이 시간 안에 아무 응답이 없으면 끊긴 것으로 본다 */
const PONG_TIMEOUT_MS = 12_000;
/** 파일 보기 토큰이 이만큼 남으면 새로 받는다 */
const FILE_TOKEN_REFRESH_MS = 60 * 60 * 1000;
const ABUSE_RETRY_MS = 8_000;

const ERROR_FALLBACK: Partial<Record<ErrorCode, string>> = {
  locked: "선생님이 보드를 잠갔어요.",
  rate_limited: "너무 빨라요. 잠깐 뒤에 다시 해 주세요.",
  internal: "잠시 문제가 생겼어요. 다시 해 주세요.",
};

export function newOpId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  let s = "";
  for (let i = 0; i < 24; i++) s += "abcdefghijklmnopqrstuvwxyz0123456789"[Math.floor(Math.random() * 36)];
  return s;
}

export function boardWsUrl(code: string, token: string | null, loc: { protocol: string; host: string } = location): string {
  const proto = loc.protocol === "https:" ? "wss:" : "ws:";
  const q = token ? `?st=${encodeURIComponent(token)}` : "";
  return `${proto}//${loc.host}/api/boards/${encodeURIComponent(code)}/ws${q}`;
}

export class BoardConnection {
  private ws: WebSocketLike | null = null;
  private server: ServerState | null = null;
  private pending: PendingOp[] = [];
  private waiters = new Map<string, { resolve: (r: AckResult) => void; reject: (e: OpError) => void }>();
  private listeners = new Set<() => void>();
  private state: ConnState = { status: "connecting", closedReason: null, view: null, pendingCount: 0 };
  private attempt = 0;
  private failedHandshakes = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private notifyQueued = false;
  private stopped = false;
  /** withTokenChange 동안: 새로 연결하지 않는다 */
  private suspended = false;
  private gotSnapshot = false;
  private detach: (() => void) | null = null;

  constructor(private readonly opts: ConnectionOptions) {}

  // ───────── 바깥에서 쓰는 것 ─────────

  getState(): ConnState {
    return this.state;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  connect(): void {
    this.stopped = false;
    if (!this.detach && !this.opts.headless) this.attachBrowserEvents();
    this.open();
  }

  /** 완전히 닫는다 (화면을 떠날 때) */
  close(): void {
    this.stopped = true;
    this.clearTimers();
    this.detach?.();
    this.detach = null;
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onclose = ws.onmessage = ws.onerror = ws.onopen = null;
      try {
        ws.close(1000);
      } catch {
        /* 무시 */
      }
    }
    for (const w of this.waiters.values()) w.reject(new OpError("closed", "연결이 닫혔어요."));
    this.waiters.clear();
  }

  /** 토큰이 바뀌었을 때(닉네임 변경 등) 바로 다시 연결 */
  reconnectNow(): void {
    if (this.stopped) return;
    this.attempt = 0;
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onclose = ws.onmessage = ws.onerror = ws.onopen = null;
      try {
        ws.close(1000);
      } catch {
        /* 무시 */
      }
    }
    this.open();
  }

  /**
   * 토큰을 바꾸는 요청(예: PIN 바꾸기)을 하는 동안 연결을 잠시 멈춘다.
   * 서버는 예전 토큰의 연결을 4001 로 끊는데, 그걸 받으면 입장 화면으로 가 버리므로 먼저 조용히 닫아 둔다.
   * fn 이 끝나면(실패해도) 그때의 토큰으로 바로 다시 연결한다. 그 사이 쓰기는 대기열에 남는다.
   */
  async withTokenChange<T>(fn: () => Promise<T>): Promise<T> {
    if (this.stopped) return fn();
    this.suspended = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const ws = this.ws;
    this.ws = null;
    this.stopPing();
    this.gotSnapshot = false;
    if (ws) {
      ws.onclose = ws.onmessage = ws.onerror = ws.onopen = null;
      try {
        ws.close(1000);
      } catch {
        /* 무시 */
      }
    }
    this.setStatus("reconnecting");
    try {
      return await fn();
    } finally {
      this.suspended = false;
      this.attempt = 0;
      this.open();
    }
  }

  /** 스냅숏을 다시 받는다 */
  sync(): void {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify({ t: "sync" }));
  }

  /**
   * 쓰기 메시지를 보낸다. 화면에는 바로 반영되고, 서버가 거절하면 되돌린 뒤 토스트를 띄운다.
   * 연결이 끊겨 있으면 대기열에 두었다가 다시 연결되면 같은 opId 로 보낸다.
   * @returns ack 결과 (거절되면 OpError 로 reject — 토스트는 이미 떴으므로 잡아서 무시해도 된다)
   */
  send(payload: Payload, extra: { attachments?: ViewAttachment[]; silent?: boolean } = {}): Promise<AckResult> {
    const opId = newOpId();
    const msg = { ...payload, opId } as WriteMessage;
    const op: PendingOp = { opId, msg };
    if (extra.attachments) op.attachments = extra.attachments;
    this.pending = [...this.pending, op];
    const p = new Promise<AckResult>((resolve, reject) => {
      this.waiters.set(opId, {
        resolve,
        reject: (e) => {
          if (!extra.silent && e.code !== "closed") this.toast(e.message);
          reject(e);
        },
      });
    });
    // 토스트를 띄운 뒤 거절을 안 잡아도 콘솔이 시끄럽지 않게
    p.catch(() => {});
    if (this.gotSnapshot && this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(msg));
    this.recompute();
    return p;
  }

  // ───────── 연결 ─────────

  private open(): void {
    if (this.stopped || this.suspended) return;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (!this.opts.headless && typeof navigator !== "undefined" && navigator.onLine === false) {
      this.setStatus("offline");
      return;
    }
    this.gotSnapshot = false;
    const url = boardWsUrl(this.opts.code, this.opts.getToken(), typeof location !== "undefined" ? location : { protocol: "http:", host: "localhost" });
    let ws: WebSocketLike;
    try {
      ws = this.opts.createSocket ? this.opts.createSocket(url) : (new WebSocket(url) as unknown as WebSocketLike);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    let opened = false;
    ws.onopen = () => {
      opened = true;
      this.failedHandshakes = 0;
      this.startPing();
    };
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      this.gotAnything();
      // 오프라인으로 표시됐지만 연결이 살아 있었다면 (짧은 끊김) 다시 "연결됨"
      if (this.gotSnapshot && this.state.status !== "open") this.setStatus("open");
      if (typeof ev.data !== "string") return;
      if (ev.data === "pong") return;
      let m: ServerMessage;
      try {
        m = JSON.parse(ev.data) as ServerMessage;
      } catch {
        return;
      }
      this.handle(m);
    };
    ws.onerror = () => {
      /* onclose 가 이어서 온다 */
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.stopPing();
      this.gotSnapshot = false;
      if (this.stopped) return;
      const code = ev.code;
      if (code === CLOSE_CODES.reauth) return this.terminate("reauth");
      if (code === CLOSE_CODES.archived) return this.terminate("archived");
      if (code === CLOSE_CODES.deleted) return this.terminate("deleted");
      if (code === CLOSE_CODES.abuse) return this.scheduleReconnect(ABUSE_RETRY_MS);
      if (!opened) {
        this.failedHandshakes++;
        // 핸드셰이크가 HTTP 오류로 막혔을 수 있다 → 원인 확인 (두 번째 실패부터)
        if (this.failedHandshakes >= 2 && this.opts.diagnose) {
          void this.opts.diagnose().then(
            (reason) => {
              if (this.stopped) return;
              if (reason) this.terminate(reason);
              else this.scheduleReconnect();
            },
            () => this.scheduleReconnect(),
          );
          this.setStatus(this.gotEver ? "reconnecting" : "connecting");
          return;
        }
      }
      this.scheduleReconnect();
    };
  }

  private gotEver = false;

  private terminate(reason: ClosedReason): void {
    this.clearTimers();
    this.state = { ...this.state, status: "closed", closedReason: reason };
    for (const w of this.waiters.values()) w.reject(new OpError("closed", "연결이 닫혔어요."));
    this.waiters.clear();
    this.pending = [];
    this.recompute();
  }

  private scheduleReconnect(delay?: number): void {
    if (this.stopped) return;
    this.setStatus(this.gotEver ? "reconnecting" : "connecting");
    const d = delay ?? backoffDelay(this.attempt++);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, d);
  }

  private handle(m: ServerMessage): void {
    switch (m.t) {
      case "snapshot":
        return this.onSnapshot(m.snapshot);
      case "ack": {
        this.pending = settle(this.pending, m.opId, m.result.postId ?? m.result.commentId ?? m.result.noticeId ?? m.result.columnId);
        const w = this.waiters.get(m.opId);
        this.waiters.delete(m.opId);
        w?.resolve(m.result);
        this.recompute();
        return;
      }
      case "error": {
        if (!m.opId) {
          if (m.code === "unauthorized") return this.terminate("reauth");
          if (m.message) this.toast(m.message);
          return;
        }
        this.pending = settle(this.pending, m.opId);
        const w = this.waiters.get(m.opId);
        this.waiters.delete(m.opId);
        const msg = m.message || ERROR_FALLBACK[m.code] || "저장하지 못했어요. 다시 해 주세요.";
        if (w) w.reject(new OpError(m.code, msg, m.retryAfterMs));
        else this.toast(msg);
        this.recompute();
        if (m.code === "unauthorized") this.terminate("reauth");
        return;
      }
      default: {
        if (!this.server) return;
        this.pending = matchCreates(this.server, this.pending, m);
        this.server = applyServerMessage(this.server, m);
        this.recompute();
      }
    }
  }

  private onSnapshot(s: BoardSnapshot): void {
    this.server = fromSnapshot(s);
    // 스냅숏 이전의 짝짓기는 믿을 수 없으니 푼다 (ack 가 다시 온다)
    this.pending = this.pending.map((op) => {
      if (!op.matchedId) return op;
      const { matchedId: _m, ...rest } = op;
      return rest;
    });
    const first = !this.gotSnapshot;
    this.gotSnapshot = true;
    this.gotEver = true;
    this.attempt = 0;
    this.state = { ...this.state, status: "open", closedReason: null };
    if (first && this.ws && this.ws.readyState === 1) {
      // 확인 못 받은 쓰기를 같은 opId 로 다시 보낸다 (서버가 중복을 막음)
      for (const op of this.pending) this.ws.send(JSON.stringify(op.msg));
    }
    this.recompute();
  }

  // ───────── 핑·이벤트 ─────────

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => this.ping(), PING_EVERY_MS);
  }

  private ping(): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== 1) return;
    try {
      ws.send("ping");
    } catch {
      return;
    }
    if (this.pongTimer) return;
    this.pongTimer = setTimeout(() => {
      this.pongTimer = null;
      // 응답 없음 → 죽은 연결. 닫고 다시 연결
      if (this.ws === ws) {
        this.ws = null;
        ws.onclose = ws.onmessage = ws.onerror = ws.onopen = null;
        try {
          ws.close(4000);
        } catch {
          /* 무시 */
        }
        this.stopPing();
        this.scheduleReconnect(0);
      }
    }, PONG_TIMEOUT_MS);
  }

  private gotAnything(): void {
    if (this.pongTimer) {
      clearTimeout(this.pongTimer);
      this.pongTimer = null;
    }
  }

  private stopPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.pongTimer) clearTimeout(this.pongTimer);
    this.pingTimer = this.pongTimer = null;
  }

  private clearTimers(): void {
    this.stopPing();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private attachBrowserEvents(): void {
    const onOnline = () => {
      if (this.stopped || this.state.status === "closed") return;
      this.attempt = 0;
      if (!this.ws) this.open();
      else this.ping();
    };
    const onOffline = () => {
      if (this.stopped || this.state.status === "closed") return;
      this.setStatus("offline");
    };
    const onVisible = () => {
      if (document.visibilityState !== "visible" || this.stopped || this.state.status === "closed") return;
      if (!this.ws) {
        this.attempt = 0;
        this.open();
        return;
      }
      // 휴대폰이 잠자는 동안 연결이 죽었을 수 있다 → 바로 확인
      this.ping();
      this.refreshFileTokenIfNeeded();
    };
    addEventListener("online", onOnline);
    addEventListener("offline", onOffline);
    document.addEventListener("visibilitychange", onVisible);
    const fileTimer = setInterval(() => this.refreshFileTokenIfNeeded(), 10 * 60 * 1000);
    this.detach = () => {
      removeEventListener("online", onOnline);
      removeEventListener("offline", onOffline);
      document.removeEventListener("visibilitychange", onVisible);
      clearInterval(fileTimer);
    };
  }

  private refreshFileTokenIfNeeded(): void {
    const s = this.server;
    if (!s) return;
    const now = Date.now() + s.clockOffset;
    if (s.fileTokenExpiresAt - now < FILE_TOKEN_REFRESH_MS) this.sync();
  }

  // ───────── 상태 알림 ─────────

  private setStatus(status: ConnStatus): void {
    if (this.state.status === status) return;
    this.state = { ...this.state, status };
    this.notify();
  }

  private recompute(): void {
    const view = this.server ? derive(this.server, this.pending) : null;
    this.state = { ...this.state, view, pendingCount: this.pending.length };
    this.notify();
  }

  private notify(): void {
    if (this.notifyQueued) return;
    this.notifyQueued = true;
    // 같은 틱에 온 메시지 여러 개를 한 번에 그린다
    queueMicrotask(() => {
      this.notifyQueued = false;
      for (const fn of this.listeners) fn();
    });
  }

  private toast(message: string): void {
    this.opts.onToast?.(message);
  }

  // ───────── 시험용 ─────────

  /** @internal */
  _debug(): { pending: PendingOp[]; server: ServerState | null } {
    return { pending: this.pending, server: this.server };
  }
}

export function isValidOpId(id: string): boolean {
  return OP_ID_RE.test(id);
}
