import { describe, expect, it, vi } from "vitest";
import type { BoardSnapshot, PostView, ServerMessage } from "../../src/shared/protocol";
import {
  applyServerMessage,
  backoffDelay,
  derive,
  fromSnapshot,
  matchCreates,
  myOnlyPost,
  postIdsForColumn,
  settle,
  tmpId,
  type PendingOp,
} from "./realtime-state";
import { BoardConnection, type WebSocketLike } from "./realtime";

function post(id: string, over: Partial<PostView> = {}): PostView {
  return {
    id,
    columnId: "s:s:me",
    authorRef: "s:me",
    authorName: "나",
    mine: true,
    title: "제목 " + id,
    body: "",
    link: "",
    status: "visible",
    createdAt: 1000,
    updatedAt: 1000,
    attachments: [],
    comments: [],
    likeCount: 0,
    likedByMe: false,
    ...over,
  };
}

function snap(over: Partial<BoardSnapshot> = {}): BoardSnapshot {
  return {
    board: { id: "b1", code: "ABCDEF" },
    settings: {
      title: "보드",
      description: "",
      type: "cumulative",
      columnMode: "student",
      entryMode: "roster",
      requirePin: true,
      moderation: false,
      locked: false,
      anonymous: false,
      allowComments: true,
      allowLikes: true,
      maxFileMB: 25,
      archived: false,
    },
    me: { role: "student", ref: "s:me", name: "나", number: "101" },
    columns: [
      { id: "teacher", title: "선생님", kind: "teacher", position: 0 },
      { id: "s:s:me", title: "나", kind: "student", ownerRef: "s:me", mine: true, position: 1 },
      { id: "s:s:you", title: "너", kind: "student", ownerRef: "s:you", position: 2 },
    ],
    posts: [post("p1", { createdAt: 100 }), post("p2", { createdAt: 200, columnId: "s:s:you", mine: false, authorRef: "s:you" })],
    notices: [],
    presence: { count: 2 },
    fileToken: "ft",
    fileTokenExpiresAt: 10_000_000,
    serverTime: 5000,
    ...over,
  };
}

describe("applyServerMessage", () => {
  it("post.upsert 는 새 카드를 createdAt 순서에 넣고, 기존 카드는 통째로 바꾼다", () => {
    const s = fromSnapshot(snap(), 5000);
    const a = applyServerMessage(s, { t: "post.upsert", post: post("p3", { createdAt: 150 }) });
    expect(a.order).toEqual(["p1", "p3", "p2"]);
    const b = applyServerMessage(a, { t: "post.upsert", post: post("p1", { createdAt: 100, title: "바뀜" }) });
    expect(b.posts.p1!.title).toBe("바뀜");
    expect(b.order).toEqual(["p1", "p3", "p2"]);
    // 다른 카드 객체는 그대로 (불필요한 다시 그리기 방지)
    expect(b.posts.p2).toBe(s.posts.p2);
  });

  it("post.remove / comment.add 중복 무시 / comment.remove / like.set", () => {
    let s = fromSnapshot(snap());
    const c = { id: "c1", postId: "p1", authorRef: "s:you", authorName: "너", mine: false, body: "안녕", createdAt: 1 };
    s = applyServerMessage(s, { t: "comment.add", comment: c });
    const same = applyServerMessage(s, { t: "comment.add", comment: c });
    expect(same).toBe(s);
    expect(s.posts.p1!.comments).toHaveLength(1);
    s = applyServerMessage(s, { t: "like.set", postId: "p1", count: 3, liked: true });
    expect(s.posts.p1!.likeCount).toBe(3);
    s = applyServerMessage(s, { t: "comment.remove", postId: "p1", commentId: "c1" });
    expect(s.posts.p1!.comments).toHaveLength(0);
    s = applyServerMessage(s, { t: "post.remove", postId: "p2" });
    expect(s.order).toEqual(["p1"]);
    expect(s.posts.p2).toBeUndefined();
  });

  it("공지는 최신 먼저, 열은 position 순", () => {
    let s = fromSnapshot(snap());
    s = applyServerMessage(s, { t: "notice.upsert", notice: { id: "n1", title: "a", body: "", createdAt: 1, updatedAt: 1 } });
    s = applyServerMessage(s, { t: "notice.upsert", notice: { id: "n2", title: "b", body: "", createdAt: 2, updatedAt: 2 } });
    expect(s.notices.map((n) => n.id)).toEqual(["n2", "n1"]);
    s = applyServerMessage(s, {
      t: "columns.set",
      columns: [
        { id: "x", title: "x", kind: "topic", position: 2 },
        { id: "y", title: "y", kind: "topic", position: 1 },
      ],
    });
    expect(s.columns.map((c) => c.id)).toEqual(["y", "x"]);
  });
});

describe("낙관적 반영과 되돌리기", () => {
  const base = () => fromSnapshot(snap(), 5000);

  it("새 카드: 임시 카드가 내 열에 보이고, 서버 방송과 짝지어지면 한 장만 남는다", () => {
    const server = base();
    let pending: PendingOp[] = [{ opId: "op-aaaaaaaa", msg: { t: "post.save", opId: "op-aaaaaaaa", post: { title: "새 글" } } }];
    let view = derive(server, pending, 5000);
    expect(view.posts[tmpId("op-aaaaaaaa")]!.columnId).toBe("s:s:me");
    expect(view.posts[tmpId("op-aaaaaaaa")]!.sending).toBe(true);
    expect(postIdsForColumn(view, "s:s:me")[0]).toBe(tmpId("op-aaaaaaaa"));

    // 서버는 방송을 먼저 보낸다
    const up: ServerMessage = { t: "post.upsert", post: post("pNew", { createdAt: 300, title: "새 글" }) };
    pending = matchCreates(server, pending, up);
    const server2 = applyServerMessage(server, up);
    view = derive(server2, pending);
    expect(view.posts[tmpId("op-aaaaaaaa")]).toBeUndefined();
    expect(postIdsForColumn(view, "s:s:me")).toEqual(["pNew", "p1"]);

    pending = settle(pending, "op-aaaaaaaa", "pNew");
    expect(pending).toHaveLength(0);
  });

  it("승인 후 게시면 학생 새 카드는 pending 으로 보인다", () => {
    const server = fromSnapshot(snap({ settings: { ...snap().settings, moderation: true } }));
    const view = derive(server, [{ opId: "op-bbbbbbbb", msg: { t: "post.save", opId: "op-bbbbbbbb", post: { body: "x" } } }]);
    expect(view.posts[tmpId("op-bbbbbbbb")]!.status).toBe("pending");
  });

  it("error 를 받으면 op 를 지우고 원래 상태로 돌아간다", () => {
    const server = base();
    const pending: PendingOp[] = [{ opId: "op-cccccccc", msg: { t: "post.delete", opId: "op-cccccccc", postId: "p1" } }];
    expect(derive(server, pending).posts.p1).toBeUndefined();
    const after = settle(pending, "op-cccccccc");
    expect(derive(server, after).posts.p1).toBe(server.posts.p1);
  });

  it("좋아요는 서버 값 기준으로 ±1, 댓글은 임시로 붙는다", () => {
    const server = base();
    const pending: PendingOp[] = [
      { opId: "op-dddddddd", msg: { t: "like.set", opId: "op-dddddddd", postId: "p2", liked: true } },
      { opId: "op-eeeeeeee", msg: { t: "comment.add", opId: "op-eeeeeeee", postId: "p2", body: "멋져" } },
    ];
    const v = derive(server, pending);
    expect(v.posts.p2!.likeCount).toBe(1);
    expect(v.posts.p2!.likedByMe).toBe(true);
    expect(v.posts.p2!.comments.map((c) => c.body)).toEqual(["멋져"]);
    // 다른 카드 객체는 건드리지 않는다
    expect(v.posts.p1).toBe(server.posts.p1);
  });

  it("같은 카드에 댓글 두 개를 보내면 보낸 순서대로 짝짓는다", () => {
    const server = base();
    let pending: PendingOp[] = [
      { opId: "op-ffffffff", msg: { t: "comment.add", opId: "op-ffffffff", postId: "p2", body: "하나" } },
      { opId: "op-gggggggg", msg: { t: "comment.add", opId: "op-gggggggg", postId: "p2", body: "둘" } },
    ];
    const m1: ServerMessage = {
      t: "comment.add",
      comment: { id: "c1", postId: "p2", authorRef: "s:me", authorName: "나", mine: true, body: "하나", createdAt: 1 },
    };
    pending = matchCreates(server, pending, m1);
    const s2 = applyServerMessage(server, m1);
    expect(pending[0]!.matchedId).toBe("c1");
    expect(pending[1]!.matchedId).toBeUndefined();
    const v = derive(s2, pending);
    expect(v.posts.p2!.comments.map((c) => c.body)).toEqual(["하나", "둘"]);
  });

  it("학생이 고친 visible 카드는 승인 대기로 보인다; 피드백·설정·열 순서도 겹친다", () => {
    const server = fromSnapshot(snap({ settings: { ...snap().settings, moderation: true, columnMode: "topic" } }));
    const v = derive(server, [
      { opId: "op-hhhhhhhh", msg: { t: "post.save", opId: "op-hhhhhhhh", post: { id: "p1", title: "고침" } } },
      { opId: "op-iiiiiiii", msg: { t: "settings.update", opId: "op-iiiiiiii", patch: { locked: true } } },
      { opId: "op-jjjjjjjj", msg: { t: "column.reorder", opId: "op-jjjjjjjj", order: ["s:s:you", "s:s:me", "teacher"] } },
    ]);
    expect(v.posts.p1!.title).toBe("고침");
    expect(v.posts.p1!.status).toBe("pending");
    expect(v.settings.locked).toBe(true);
    expect(v.columns.map((c) => c.id)).toEqual(["s:s:you", "s:s:me", "teacher"]);
  });

  it("ack 의 id 가 다른 op 에 잘못 짝지어졌으면 바로잡는다", () => {
    let pending: PendingOp[] = [
      { opId: "op-k1111111", msg: { t: "post.save", opId: "op-k1111111", post: { title: "a" } }, matchedId: "pB" },
      { opId: "op-k2222222", msg: { t: "post.save", opId: "op-k2222222", post: { title: "b" } }, matchedId: "pA" },
    ];
    pending = settle(pending, "op-k1111111", "pA");
    expect(pending).toEqual([{ opId: "op-k2222222", msg: pending[0]!.msg, matchedId: "pB" }]);
  });

  it("단일 주제 보드에서 내 카드를 찾는다", () => {
    const s = fromSnapshot(snap({ settings: { ...snap().settings, type: "single" } }));
    expect(myOnlyPost(s)!.id).toBe("p1");
  });
});

describe("backoffDelay", () => {
  it("0.5초에서 두 배씩, 최대 30초, ±30%", () => {
    expect(backoffDelay(0, () => 0.5)).toBe(500);
    expect(backoffDelay(3, () => 0.5)).toBe(4000);
    expect(backoffDelay(20, () => 0.5)).toBe(30000);
    expect(backoffDelay(0, () => 1)).toBe(650);
    expect(backoffDelay(0, () => 0)).toBe(350);
  });
});

// ───────── 연결 계층 (가짜 소켓) ─────────

class FakeSocket implements WebSocketLike {
  readyState = 0;
  sent: string[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number; reason?: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  constructor(readonly url: string) {}
  send(d: string) {
    this.sent.push(d);
  }
  close() {
    this.readyState = 3;
  }
  serverOpen() {
    this.readyState = 1;
    this.onopen?.({});
  }
  serverSend(m: ServerMessage) {
    this.onmessage?.({ data: JSON.stringify(m) });
  }
  serverClose(code: number) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

function setup(token: string | null = "tok") {
  const sockets: FakeSocket[] = [];
  const toasts: string[] = [];
  const conn = new BoardConnection({
    code: "ABCDEF",
    getToken: () => token,
    onToast: (m) => toasts.push(m),
    headless: true,
    createSocket: (url) => {
      const s = new FakeSocket(url);
      sockets.push(s);
      return s;
    },
  });
  return { conn, sockets, toasts };
}

const flush = () => new Promise<void>((r) => queueMicrotask(r));

describe("BoardConnection", () => {
  it("학생 토큰을 ?st= 로 붙여 연결하고 스냅숏을 받으면 open", async () => {
    const { conn, sockets } = setup();
    conn.connect();
    expect(sockets[0]!.url).toContain("/api/boards/ABCDEF/ws?st=tok");
    sockets[0]!.serverOpen();
    sockets[0]!.serverSend({ t: "snapshot", snapshot: snap() });
    expect(conn.getState().status).toBe("open");
    expect(conn.getState().view!.order).toEqual(["p1", "p2"]);
    conn.close();
  });

  it("error 면 되돌리고 서버 한국어 메시지로 토스트", async () => {
    const { conn, sockets, toasts } = setup();
    conn.connect();
    const s = sockets[0]!;
    s.serverOpen();
    s.serverSend({ t: "snapshot", snapshot: snap() });
    const p = conn.send({ t: "post.delete", postId: "p1" });
    expect(conn.getState().view!.posts.p1).toBeUndefined();
    const sent = JSON.parse(s.sent.at(-1)!) as { opId: string; t: string };
    expect(sent.t).toBe("post.delete");
    s.serverSend({ t: "error", opId: sent.opId, code: "forbidden", message: "내 카드만 지울 수 있어요." });
    await expect(p).rejects.toThrow("내 카드만 지울 수 있어요.");
    expect(conn.getState().view!.posts.p1).toBeDefined();
    expect(toasts).toEqual(["내 카드만 지울 수 있어요."]);
    conn.close();
  });

  it("끊기면 백오프로 다시 연결하고, 확인 못 받은 쓰기를 같은 opId 로 다시 보낸다", async () => {
    vi.useFakeTimers();
    try {
      const { conn, sockets } = setup();
      conn.connect();
      sockets[0]!.serverOpen();
      sockets[0]!.serverSend({ t: "snapshot", snapshot: snap() });
      void conn.send({ t: "like.set", postId: "p2", liked: true });
      const opId = (JSON.parse(sockets[0]!.sent.at(-1)!) as { opId: string }).opId;
      sockets[0]!.serverClose(1006);
      expect(conn.getState().status).toBe("reconnecting");
      // 끊긴 동안에도 낙관적 상태는 유지
      expect(conn.getState().view!.posts.p2!.likedByMe).toBe(true);
      vi.advanceTimersByTime(1000);
      expect(sockets).toHaveLength(2);
      sockets[1]!.serverOpen();
      sockets[1]!.serverSend({ t: "snapshot", snapshot: snap() });
      expect(sockets[1]!.sent.map((d) => (JSON.parse(d) as { opId: string }).opId)).toEqual([opId]);
      conn.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("4001 이면 다시 연결하지 않고 reauth 로 닫힌다", async () => {
    vi.useFakeTimers();
    try {
      const { conn, sockets } = setup();
      conn.connect();
      sockets[0]!.serverOpen();
      sockets[0]!.serverClose(4001);
      vi.advanceTimersByTime(60_000);
      expect(sockets).toHaveLength(1);
      expect(conn.getState()).toMatchObject({ status: "closed", closedReason: "reauth" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("withTokenChange: 토큰을 바꾸는 동안 연결을 멈추고(4001 을 안 받음), 끝나면 새 토큰으로 바로 다시 연결", async () => {
    let token = "old";
    const sockets: FakeSocket[] = [];
    const conn = new BoardConnection({
      code: "ABCDEF",
      getToken: () => token,
      headless: true,
      createSocket: (url) => {
        const s = new FakeSocket(url);
        sockets.push(s);
        return s;
      },
    });
    conn.connect();
    sockets[0]!.serverOpen();
    sockets[0]!.serverSend({ t: "snapshot", snapshot: snap() });
    let release!: () => void;
    const p = conn.withTokenChange(
      () =>
        new Promise<void>((r) => {
          release = () => {
            token = "new";
            r();
          };
        }),
    );
    expect(sockets[0]!.onclose).toBeNull(); // 예전 연결은 조용히 닫힘 → 서버의 4001 이 와도 입장 화면으로 안 감
    expect(conn.getState().status).toBe("reconnecting");
    void conn.send({ t: "like.set", postId: "p2", liked: true });
    expect(sockets).toHaveLength(1);
    release();
    await p;
    expect(sockets).toHaveLength(2);
    expect(sockets[1]!.url).toContain("?st=new");
    sockets[1]!.serverOpen();
    sockets[1]!.serverSend({ t: "snapshot", snapshot: snap() });
    expect(conn.getState().status).toBe("open");
    expect(sockets[1]!.sent.map((d) => (JSON.parse(d) as { t: string }).t)).toEqual(["like.set"]);
    // 실패해도 다시 연결 (그때의 토큰으로)
    await expect(conn.withTokenChange(() => Promise.reject(new Error("x")))).rejects.toThrow("x");
    expect(sockets).toHaveLength(3);
    conn.close();
  });

  it("4008 이면 몇 초 기다렸다가 다시 연결", async () => {
    vi.useFakeTimers();
    try {
      const { conn, sockets } = setup();
      conn.connect();
      sockets[0]!.serverOpen();
      sockets[0]!.serverClose(4008);
      vi.advanceTimersByTime(3000);
      expect(sockets).toHaveLength(1);
      vi.advanceTimersByTime(6000);
      expect(sockets).toHaveLength(2);
      conn.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("핑에 응답이 없으면 끊고 다시 연결한다", async () => {
    vi.useFakeTimers();
    try {
      const { conn, sockets } = setup();
      conn.connect();
      sockets[0]!.serverOpen();
      sockets[0]!.serverSend({ t: "snapshot", snapshot: snap() });
      vi.advanceTimersByTime(40_000);
      expect(sockets[0]!.sent).toContain("ping");
      vi.advanceTimersByTime(13_000);
      expect(sockets.length).toBe(2);
      conn.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("핸드셰이크가 계속 실패하면 diagnose 로 원인을 보고 멈춘다", async () => {
    vi.useFakeTimers();
    try {
      const sockets: FakeSocket[] = [];
      const conn = new BoardConnection({
        code: "ABCDEF",
        getToken: () => "t",
        headless: true,
        diagnose: async () => "archived",
        createSocket: (url) => {
          const s = new FakeSocket(url);
          sockets.push(s);
          return s;
        },
      });
      conn.connect();
      sockets[0]!.serverClose(1006);
      await vi.advanceTimersByTimeAsync(1000);
      sockets[1]!.serverClose(1006);
      await vi.advanceTimersByTimeAsync(10);
      expect(conn.getState()).toMatchObject({ status: "closed", closedReason: "archived" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("여러 메시지를 한 번에 알린다 (마이크로태스크로 묶음)", async () => {
    const { conn, sockets } = setup();
    let n = 0;
    conn.subscribe(() => n++);
    conn.connect();
    sockets[0]!.serverOpen();
    sockets[0]!.serverSend({ t: "snapshot", snapshot: snap() });
    sockets[0]!.serverSend({ t: "presence", presence: { count: 3 } });
    sockets[0]!.serverSend({ t: "like.set", postId: "p1", count: 1, liked: false });
    await flush();
    expect(n).toBe(1);
    conn.close();
  });
});
