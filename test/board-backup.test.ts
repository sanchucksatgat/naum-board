import { beforeEach, describe, expect, it } from "vitest";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { resetAll, call } from "./helpers";
import { asTeacher, boardStub, connect, freeJoin, makeBoard, type Teacher } from "./board-helpers";
import { BACKUP_DELAY_MS, BACKUP_MAX_FAILURES, BACKUP_RETRY_BASE_MS, resetBoardDriveFns, setBoardDriveFns } from "../src/worker/board";
import { DriveError } from "../src/worker/drive";
import type { BoardSummary, RecentPostsResponse, ServerMessage } from "../src/shared/protocol";
import type { BoardDriveResponse } from "../src/shared/files";

let t: Teacher;
let calls: Array<{ boardId: string; content: Record<string, unknown> }>;
let failWith: Error | null;

beforeEach(async () => {
  await resetAll();
  resetBoardDriveFns();
  calls = [];
  failWith = null;
  setBoardDriveFns({
    writeBoardBackup: async (_env, boardId, content, opts) => {
      expect(opts?.state).toBeTruthy(); // 자기 RPC 대신 상태를 직접 넘긴다
      expect(opts?.board).toBeTruthy();
      calls.push({ boardId, content: content as Record<string, unknown> });
      if (failWith) throw failWith;
      await opts!.board!.setDriveState({ lastBackupAt: Date.now(), backupError: null, backupFileId: "bk1" });
    },
    renameBoardFolder: async () => {},
  });
  t = await asTeacher();
});

const alarmAt = (id: string) => runInDurableObject(boardStub(id), (_i, state) => state.storage.getAlarm());

async function setup() {
  const board = await makeBoard(t, { title: "백업 보드", entryMode: "free" });
  const s = await connect(board.code, { token: await freeJoin(board.code, "토끼") });
  const teacher = await connect(board.code, { session: t.session });
  return { board, s, teacher };
}

const backupMsgs = (c: { msgs: ServerMessage[] }) => c.msgs.filter((m): m is Extract<ServerMessage, { t: "backup.status" }> => m.t === "backup.status");

describe("백업 알람", () => {
  it("변경 30초 뒤 한 번 (그 사이 변경은 모아서), 성공하면 ok", async () => {
    const { board, s, teacher } = await setup();
    const before = Date.now();
    await s.ok({ t: "post.save", post: { body: "첫 글" } });
    const at1 = await alarmAt(board.id);
    expect(at1).toBeGreaterThanOrEqual(before + BACKUP_DELAY_MS - 50);
    expect(at1).toBeLessThanOrEqual(Date.now() + BACKUP_DELAY_MS + 50);
    await teacher.waitFor((m) => m.t === "backup.status" && m.backup.state === "pending");
    // 디바운스: 다음 변경은 알람을 미루지도, 새로 걸지도 않는다
    await s.ok({ t: "post.save", post: { body: "둘째 글" } });
    await s.ok({ t: "post.save", post: { body: "셋째 글" } });
    expect(await alarmAt(board.id)).toBe(at1);
    expect(backupMsgs(teacher).length).toBe(1);

    expect(await runDurableObjectAlarm(boardStub(board.id))).toBe(true);
    expect(calls.length).toBe(1);
    const posts = calls[0]!.content.posts as Array<{ body: string; authorName: string }>;
    expect(posts.map((p) => p.body)).toEqual(["첫 글", "둘째 글", "셋째 글"]);
    expect(calls[0]!.content).toMatchObject({ format: "nanumboard-backup", version: 1 });
    const ok = await teacher.waitFor((m) => m.t === "backup.status" && m.backup.state === "ok");
    expect(ok.t === "backup.status" && ok.backup.lastSuccessAt).toBeGreaterThan(0);
    expect(await alarmAt(board.id)).toBeNull();
    // 학생은 백업 상태를 받지 않는다
    expect(backupMsgs(s).length).toBe(0);

    // Task3 의 GET /api/boards/:code/drive 도 같은 상태
    const drive = (await (await t.req("GET", `/api/boards/${board.code}/drive`)).json()) as BoardDriveResponse;
    expect(drive.backup.status).toBe("ok");
    // 통계·최근 글이 Registry 에 반영
    const list = await t.json<{ boards: BoardSummary[] }>("GET", "/api/teacher/boards");
    expect(list.boards[0]!.postCount).toBe(3);
    const recent = await t.json<RecentPostsResponse>("GET", "/api/teacher/recent-posts?limit=2");
    expect(recent.posts.map((p) => p.excerpt)).toEqual(["셋째 글", "둘째 글"]);
    expect(recent.posts[0]).toMatchObject({ boardCode: board.code, boardTitle: "백업 보드", authorName: "토끼" });
  });

  it("실패하면 지수 백오프로 다시 시도하고 교사에게 오류 상태를 보인다", async () => {
    const { board, s, teacher } = await setup();
    await s.ok({ t: "post.save", post: { body: "글" } });
    failWith = new DriveError("unavailable", 503);
    const delays: number[] = [];
    for (let i = 1; i <= 3; i++) {
      const t0 = Date.now();
      expect(await runDurableObjectAlarm(boardStub(board.id))).toBe(true);
      const next = (await alarmAt(board.id))!;
      delays.push(next - t0);
      const st = await teacher.waitFor((m) => m.t === "backup.status" && m.backup.failures === i);
      expect(st.t === "backup.status" && st.backup).toMatchObject({ state: "error", lastError: expect.stringContaining("Google 드라이브") });
    }
    expect(delays[0]).toBeGreaterThanOrEqual(BACKUP_RETRY_BASE_MS - 100);
    expect(delays[1]).toBeGreaterThanOrEqual(2 * BACKUP_RETRY_BASE_MS - 100);
    expect(delays[2]).toBeGreaterThanOrEqual(4 * BACKUP_RETRY_BASE_MS - 100);
    expect(delays[2]).toBeLessThan(4 * BACKUP_RETRY_BASE_MS + 1000);
    // 실패 중의 변경은 알람을 앞당기지 않는다
    const pending = await alarmAt(board.id);
    await s.ok({ t: "post.save", post: { body: "글2" } });
    expect(await alarmAt(board.id)).toBe(pending);
    const drive = (await (await t.req("GET", `/api/boards/${board.code}/drive`)).json()) as BoardDriveResponse;
    expect(drive.backup.status).toBe("error");
    expect(drive.backup.error).toContain("Google 드라이브");
    // 교사 스냅숏에도
    expect((await teacher.sync()).backup!.state).toBe("error");

    failWith = null;
    await runDurableObjectAlarm(boardStub(board.id));
    await teacher.waitFor((m) => m.t === "backup.status" && m.backup.state === "ok" && m.backup.failures === 0);
    expect((calls.at(-1)!.content.posts as unknown[]).length).toBe(2);
  });

  it("연결이 끊긴 Drive 는 unavailable, 계속 실패하면 쉬었다가 다음 변경 때 다시", async () => {
    const { board, s, teacher } = await setup();
    await s.ok({ t: "post.save", post: { body: "글" } });
    failWith = new DriveError("reconnect");
    for (let i = 0; i < BACKUP_MAX_FAILURES; i++) await runDurableObjectAlarm(boardStub(board.id));
    expect(await alarmAt(board.id)).toBeNull();
    const st = (await teacher.sync()).backup!;
    expect(st).toMatchObject({ state: "unavailable", failures: BACKUP_MAX_FAILURES, nextAttemptAt: null });
    await s.ok({ t: "post.save", post: { body: "새 변경" } });
    expect(await alarmAt(board.id)).not.toBeNull();
  });

  it("DO 를 내보낸 뒤에도 알람·상태가 남는다 (메모리에만 있지 않음)", async () => {
    const { board, s } = await setup();
    await s.ok({ t: "post.save", post: { body: "글" } });
    const at = await alarmAt(board.id);
    const { evictDurableObject } = await import("cloudflare:test");
    await evictDurableObject(boardStub(board.id));
    expect(await alarmAt(board.id)).toBe(at);
    await runDurableObjectAlarm(boardStub(board.id));
    expect(calls.length).toBe(1);
    expect((await boardStub(board.id).getTeacherDetail())!.backup.state).toBe("ok");
  });

  it("교사 REST 로 설정을 바꿔도 백업이 걸린다", async () => {
    const board = await makeBoard(t, { title: "x", entryMode: "free" });
    expect(await alarmAt(board.id)).toBeNull();
    const res = await call(`/api/teacher/boards/${board.id}`, {
      method: "PATCH",
      headers: { cookie: `__Host-nb_session=${encodeURIComponent(t.session)}`, "content-type": "application/json" },
      body: JSON.stringify({ description: "안내" }),
    });
    expect(res.status).toBe(200);
    expect(await alarmAt(board.id)).not.toBeNull();
  });
});
