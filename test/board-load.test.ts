import { beforeEach, describe, expect, it } from "vitest";
import { resetAll } from "./helpers";
import { asTeacher, connect, freeJoin, makeBoard, newOpId, type Client } from "./board-helpers";
import { resetBoardDriveFns, setBoardDriveFns } from "../src/worker/board";

beforeEach(async () => {
  await resetAll();
  resetBoardDriveFns();
  setBoardDriveFns({ writeBoardBackup: async () => {}, renameBoardFolder: async () => {} });
});

describe("부하 비슷한 시험", () => {
  it("한 보드에 50명, 동시에 카드 100장·좋아요 50개 → 모두 같은 상태", async () => {
    const t = await asTeacher();
    const board = await makeBoard(t, { title: "50명", entryMode: "free" });
    const tokens = await Promise.all(Array.from({ length: 50 }, (_, i) => freeJoin(board.code, `학생${i + 1}`)));
    const clients: Client[] = [];
    for (const tok of tokens) clients.push(await connect(board.code, { token: tok }));
    const teacher = await connect(board.code, { session: t.session });
    const everyone = [...clients, teacher];
    expect((await teacher.sync()).presence.count).toBe(51);

    // 각자 카드 2장을 한꺼번에 (ack 를 기다리지 않고)
    const sent: string[] = [];
    for (const [i, c] of clients.entries()) {
      for (let k = 0; k < 2; k++) {
        const opId = newOpId();
        sent.push(opId);
        c.sendRaw(JSON.stringify({ t: "post.save", opId, post: { body: `학생${i + 1}의 ${k + 1}번째 카드` } }));
      }
    }
    const deadline = Date.now() + 20_000;
    while (everyone.some((c) => c.posts.size < 100) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    for (const c of everyone) expect(c.posts.size).toBe(100);
    // 모든 학생이 자기 ack 2개
    for (const c of clients) expect(c.msgs.filter((m) => m.t === "ack").length).toBe(2);

    // 첫 카드에 모두 좋아요
    const first = [...teacher.posts.keys()][0]!;
    for (const c of clients) c.sendRaw(JSON.stringify({ t: "like.set", opId: newOpId(), postId: first, liked: true }));
    const d2 = Date.now() + 20_000;
    while (everyone.some((c) => c.posts.get(first)!.likeCount !== 50) && Date.now() < d2) await new Promise((r) => setTimeout(r, 20));

    const ids = [...teacher.posts.keys()].sort().join(",");
    for (const c of everyone) {
      expect([...c.posts.keys()].sort().join(",")).toBe(ids);
      expect(c.posts.get(first)!.likeCount).toBe(50);
    }
    // 서버 상태와도 같다
    const snap = await teacher.sync();
    expect(snap.posts.length).toBe(100);
    expect(snap.posts.map((p) => p.id).sort().join(",")).toBe(ids);
    expect(clients.every((c) => c.posts.get(first)!.likedByMe)).toBe(true);
    for (const c of everyone) c.close();
  }, 60_000);
});
