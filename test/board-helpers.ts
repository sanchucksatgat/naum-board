/** 보드(태스크2) 테스트 도구: 교사 REST, 학생 입장, 웹소켓 클라이언트 */
import { expect } from "vitest";
import { env } from "cloudflare:workers";
import { call, loginAs, ORIGIN } from "./helpers";
import { getBoardStub } from "../src/worker/stubs";
import type {
  BoardDetail, BoardSnapshot, ClientMessage, PostView, ServerMessage, StudentRowInput, TeacherStudent, ClassSummary, TokenResponse, LoginResponse,
} from "../src/shared/protocol";

export const TEACHER = { sub: "sub-teacher", email: "teacher@example.com" };

export interface Teacher {
  session: string;
  req(method: string, path: string, body?: unknown, extra?: Record<string, string>): Promise<Response>;
  json<T>(method: string, path: string, body?: unknown): Promise<T>;
}

export async function asTeacher(): Promise<Teacher> {
  const { session } = await loginAs(TEACHER);
  const cookie = `__Host-nb_session=${encodeURIComponent(session!)}`;
  const req = (method: string, path: string, body?: unknown, extra: Record<string, string> = {}) =>
    call(path, {
      method,
      headers: { cookie, origin: ORIGIN, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...extra },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  return {
    session: session!,
    req,
    async json<T>(method: string, path: string, body?: unknown): Promise<T> {
      const res = await req(method, path, body);
      if (res.status >= 300) throw new Error(`${method} ${path} → ${res.status} ${await res.text()}`);
      return (res.status === 204 ? null : await res.json()) as T;
    },
  };
}

export async function makeClass(t: Teacher, name: string, students: StudentRowInput[]) {
  return t.json<{ class: ClassSummary; students: TeacherStudent[] }>("POST", "/api/teacher/classes", { name, students });
}

export async function makeBoard(t: Teacher, body: Record<string, unknown>): Promise<BoardDetail> {
  return t.json<BoardDetail>("POST", "/api/teacher/boards", body);
}

export function publicPost(path: string, body: unknown, headers: Record<string, string> = {}) {
  return call(path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
}

/**
 * 명단 학생 입장 → 학생 토큰. 처음 PIN 으로 들어가지면 myPin 으로 바꾼다(예전 "처음 입장 때 나만의 PIN 정하기"와 같은 상태).
 * 이미 바꿨으면 myPin 으로 들어간다. myPin 이 null 이면 처음 PIN 그대로 들어간 토큰을 준다.
 */
export async function rosterLogin(code: string, number: string, initialPin: string, myPin: string | null = "4826"): Promise<string> {
  let res = await publicPost(`/api/boards/${code}/login`, { number, pin: initialPin });
  if (res.status !== 200 && myPin) {
    res = await publicPost(`/api/boards/${code}/login`, { number, pin: myPin });
    expect(res.status, await res.clone().text()).toBe(200);
    return ((await res.json()) as LoginResponse).token;
  }
  expect(res.status, await res.clone().text()).toBe(200);
  const body = (await res.json()) as LoginResponse;
  if (!myPin) return body.token;
  const r2 = await changePin(code, body.token, initialPin, myPin);
  expect(r2.status, await r2.clone().text()).toBe(200);
  return ((await r2.json()) as TokenResponse).token;
}

/** 학생이 "내 정보"에서 PIN 바꾸기 */
export function changePin(code: string, token: string, currentPin: unknown, newPin: unknown, headers: Record<string, string> = {}) {
  return publicPost(`/api/boards/${code}/pin`, { currentPin, newPin }, { authorization: `Bearer ${token}`, ...headers });
}

export async function freeJoin(code: string, nickname: string, device = "device-" + crypto.randomUUID().replace(/-/g, "")): Promise<string> {
  const res = await publicPost(`/api/boards/${code}/join`, { nickname, deviceToken: device });
  expect(res.status, await res.clone().text()).toBe(200);
  return ((await res.json()) as TokenResponse).token;
}

let opSeq = 0;
export const newOpId = () => `op_${Date.now().toString(36)}_${(++opSeq).toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

type Ack = Extract<ServerMessage, { t: "ack" }>;
type Err = Extract<ServerMessage, { t: "error" }>;

/** 테스트용 웹소켓 클라이언트: 받은 메시지를 모으고, 스냅숏 + 변경분으로 카드 상태를 유지한다 */
export class Client {
  msgs: ServerMessage[] = [];
  raw: string[] = [];
  closed: { code: number; reason: string } | null = null;
  posts = new Map<string, PostView>();
  snapshot: BoardSnapshot | null = null;
  private waiters: Array<{ pred: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void; from: number }> = [];
  private closeWaiters: Array<() => void> = [];

  constructor(readonly ws: WebSocket) {
    ws.accept();
    ws.addEventListener("message", (e) => {
      const data = typeof e.data === "string" ? e.data : "";
      this.raw.push(data);
      if (data === "pong") return;
      const m = JSON.parse(data) as ServerMessage;
      this.msgs.push(m);
      this.apply(m);
      const idx = this.msgs.length - 1;
      this.waiters = this.waiters.filter((w) => {
        if (idx >= w.from && w.pred(m)) {
          w.resolve(m);
          return false;
        }
        return true;
      });
    });
    ws.addEventListener("close", (e) => {
      this.closed = { code: e.code, reason: e.reason };
      for (const f of this.closeWaiters) f();
    });
  }

  private apply(m: ServerMessage) {
    if (m.t === "snapshot") {
      this.snapshot = m.snapshot;
      this.posts = new Map(m.snapshot.posts.map((p) => [p.id, p]));
    } else if (m.t === "post.upsert") this.posts.set(m.post.id, m.post);
    else if (m.t === "post.remove") this.posts.delete(m.postId);
    else if (m.t === "comment.add") {
      const p = this.posts.get(m.comment.postId);
      if (p && !p.comments.some((c) => c.id === m.comment.id)) p.comments.push(m.comment);
    } else if (m.t === "like.set") {
      const p = this.posts.get(m.postId);
      if (p) {
        p.likeCount = m.count;
        p.likedByMe = m.liked;
      }
    }
  }

  waitFor<T extends ServerMessage = ServerMessage>(pred: (m: ServerMessage) => boolean, opts: { from?: number; timeout?: number } = {}): Promise<T> {
    const from = opts.from ?? 0;
    for (let i = from; i < this.msgs.length; i++) if (pred(this.msgs[i]!)) return Promise.resolve(this.msgs[i] as T);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout waiting for message; got: " + JSON.stringify(this.msgs.slice(from)).slice(0, 2000))), opts.timeout ?? 3000);
      this.waiters.push({ pred, from, resolve: (m) => { clearTimeout(timer); resolve(m as T); } });
    });
  }

  waitClose(timeout = 3000): Promise<{ code: number; reason: string }> {
    if (this.closed) return Promise.resolve(this.closed);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout waiting for close")), timeout);
      this.closeWaiters.push(() => { clearTimeout(timer); resolve(this.closed!); });
    });
  }

  sendRaw(s: string) {
    this.ws.send(s);
  }

  /** 작업을 보내고 같은 opId 의 ack/error 를 기다린다 */
  async op(msg: Record<string, unknown> & { t: ClientMessage["t"] }, opId = newOpId()): Promise<Ack | Err> {
    const from = this.msgs.length;
    this.ws.send(JSON.stringify({ ...msg, opId }));
    return this.waitFor<Ack | Err>((m) => (m.t === "ack" || m.t === "error") && (m as Ack).opId === opId, { from });
  }

  async ok(msg: Record<string, unknown> & { t: ClientMessage["t"] }, opId?: string): Promise<Ack> {
    const r = await this.op(msg, opId);
    if (r.t !== "ack") throw new Error("expected ack, got " + JSON.stringify(r));
    return r;
  }

  /** 배리어: 스냅숏을 다시 받아 그 전 방송이 모두 도착했음을 보장 */
  async sync(): Promise<BoardSnapshot> {
    const from = this.msgs.length;
    this.ws.send(JSON.stringify({ t: "sync" }));
    const m = await this.waitFor<Extract<ServerMessage, { t: "snapshot" }>>((x) => x.t === "snapshot", { from });
    return m.snapshot;
  }

  close() {
    try {
      this.ws.close(1000, "done");
    } catch {
      /* */
    }
  }
}

export async function connectRaw(code: string, auth: { token?: string; session?: string; origin?: string }): Promise<Response> {
  const headers: Record<string, string> = { upgrade: "websocket" };
  if (auth.session) headers.cookie = `__Host-nb_session=${encodeURIComponent(auth.session)}`;
  if (auth.origin) headers.origin = auth.origin;
  const q = auth.token ? `?st=${encodeURIComponent(auth.token)}` : "";
  return call(`/api/boards/${code}/ws${q}`, { headers });
}

export async function connect(code: string, auth: { token?: string; session?: string }): Promise<Client> {
  const res = await connectRaw(code, auth);
  expect(res.status, res.status === 101 ? "" : await res.text()).toBe(101);
  const c = new Client(res.webSocket!);
  await c.waitFor((m) => m.t === "snapshot");
  return c;
}

export function boardStub(boardId: string) {
  return getBoardStub(env, boardId);
}

export const ROSTER: StudentRowInput[] = [
  { number: "20301", name: "김하나", pin: "1357", group: "1모둠" },
  { number: "20302", name: "이서준", pin: "2468", group: "1모둠" },
  { number: "20303", name: "박지우", pin: "3579", group: "2모둠", nickname: "별빛" },
];

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
