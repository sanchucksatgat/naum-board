/**
 * 태스크2 ↔ 태스크3 통합: 실제 라우트·DO·Drive 코드 + 가짜 Google Drive (test/drive-fake.ts).
 * 학생 업로드 → 완료 → post.save(업로드 확인 토큰) → 다른 학생이 첨부 카드 받음 → 파일 보기 → 백업 알람.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runDurableObjectAlarm } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { getBoardStub } from "../src/worker/stubs";
import { call, ORIGIN, resetAll } from "./helpers";
import { FakeDrive } from "./drive-fake";
import { asTeacher, connect, freeJoin, makeBoard, TEACHER, type Teacher } from "./board-helpers";
import { resetDriveDeps, setDriveDeps } from "../src/worker/drive/deps";
import { resetDriveFolderCache } from "../src/worker/drive/folders";
import { authenticateBoardActor } from "../src/worker/board/actor";
import { resetBoardDriveFns } from "../src/worker/board";
import type { CompleteUploadResponse, CreateUploadResponse, BoardDriveResponse } from "../src/shared/files";

let t: Teacher;
let drive: FakeDrive;

beforeEach(async () => {
  await resetAll();
  resetDriveDeps();
  resetDriveFolderCache();
  resetBoardDriveFns();
  // index.ts 가 모듈 초기화 때 하는 연결 (다른 테스트 파일이 reset 했을 수 있어 다시)
  setDriveDeps({ authenticateBoardActor });
  t = await asTeacher();
  drive = new FakeDrive(TEACHER);
  drive.install();
});

afterEach(() => {
  resetDriveDeps();
  setDriveDeps({ authenticateBoardActor });
});

function studentPost(path: string, token: string, body: unknown) {
  return call(path, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

async function upload(code: string, token: string, bytes: Uint8Array, name = "관찰.webp", mime = "image/webp") {
  const r1 = await studentPost(`/api/boards/${code}/uploads`, token, { name, size: bytes.byteLength, mime, width: 40, height: 30 });
  expect(r1.status, await r1.clone().text()).toBe(200);
  const up = (await r1.json()) as CreateUploadResponse;
  const put = (await (await drive.handle(new Request(up.uploadUrl, { method: "PUT", body: bytes }))).json()) as { id: string };
  const r2 = await studentPost(`/api/boards/${code}/uploads/${encodeURIComponent(up.uploadId)}/complete`, token, { sessionUrl: up.uploadUrl, driveFileId: put.id });
  expect(r2.status, await r2.clone().text()).toBe(200);
  return (await r2.json()) as CompleteUploadResponse;
}

describe("첨부 업로드 → 실시간 카드 → 파일 보기 → 백업", () => {
  it("전 과정", async () => {
    const board = await makeBoard(t, { title: "통합 보드", entryMode: "free" });
    const tokA = await freeJoin(board.code, "토끼");
    const tokB = await freeJoin(board.code, "거북");
    const a = await connect(board.code, { token: tokA });
    const b = await connect(board.code, { token: tokB });
    const teacher = await connect(board.code, { session: t.session });

    const bytes = new Uint8Array(Array.from({ length: 64 }, (_, i) => (i * 7) & 255));
    const done = await upload(board.code, tokA, bytes);
    expect(done.file).toMatchObject({ boardId: board.id, name: "관찰.webp", kind: "image", size: 64 });

    // 다른 학생은 남의 업로드 토큰을 쓸 수 없다
    const stolen = await b.op({ t: "post.save", post: { body: "훔침", attachments: [{ uploadToken: done.token }] } });
    expect(stolen.t === "error" && stolen.code).toBe("invalid_upload");

    const ack = await a.ok({ t: "post.save", post: { title: "새싹", attachments: [{ uploadToken: done.token }] } });
    const got = await b.waitFor((m) => m.t === "post.upsert" && m.post.id === ack.result.postId);
    if (got.t !== "post.upsert") throw new Error();
    expect(got.post.attachments).toHaveLength(1);
    const att = got.post.attachments[0]!;
    expect(att).toMatchObject({ name: "관찰.webp", mime: "image/webp", kind: "image", size: 64, width: 40, height: 30 });
    expect(JSON.stringify(got.post)).not.toContain(done.file.driveFileId); // Drive id 는 클라이언트에 안 보냄

    // 파일 보기: /api/files/{boardId}/{attachmentId}?t={스냅숏 fileToken}
    const fileToken = b.snapshot!.fileToken;
    const res = await call(`/api/files/${b.snapshot!.board.id}/${att.id}?t=${encodeURIComponent(fileToken)}`);
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
    // 다른 보드의 토큰으로는 안 됨
    const other = await makeBoard(t, { title: "다른 보드", entryMode: "free" });
    const oc = await connect(other.code, { token: await freeJoin(other.code, "x") });
    expect((await call(`/api/files/${board.id}/${att.id}?t=${encodeURIComponent(oc.snapshot!.fileToken)}`)).status).toBe(403);

    // 첨부 빼기 (수정)
    await a.ok({ t: "post.save", post: { id: ack.result.postId, body: "사진 뺌", attachments: [] } });
    await b.waitFor((m) => m.t === "post.upsert" && m.post.id === ack.result.postId && m.post.attachments.length === 0);

    // 백업 알람 → 가짜 Drive 에 게시글 백업.json
    expect(await runDurableObjectAlarm(teacherStub(board.id))).toBe(true);
    const backup = [...drive.files.values()].find((f) => f.name === "게시글 백업.json");
    expect(backup).toBeTruthy();
    const json = JSON.parse(new TextDecoder().decode(backup!.content)) as { posts: Array<{ body: string; authorName: string }> };
    expect(json.posts[0]).toMatchObject({ body: "사진 뺌", authorName: "토끼" });
    await teacher.waitFor((m) => m.t === "backup.status" && m.backup.state === "ok");
    const info = (await (await t.req("GET", `/api/boards/${board.code}/drive`)).json()) as BoardDriveResponse;
    expect(info.backup.status).toBe("ok");
    expect(info.folderUrl).toContain(backup!.parents[0]!);

    // 두 번째 백업은 같은 파일을 갱신
    await a.ok({ t: "post.save", post: { body: "두 번째" } });
    await runDurableObjectAlarm(teacherStub(board.id));
    expect([...drive.files.values()].filter((f) => f.name === "게시글 백업.json")).toHaveLength(1);
    expect(new TextDecoder().decode(backup!.content)).toContain("두 번째");

    // 보드 이름 바꾸면 폴더 이름도
    await t.json("PATCH", `/api/teacher/boards/${board.id}`, { title: "새 이름" });
    const deadline = Date.now() + 2000;
    const folder = drive.files.get(backup!.parents[0]!)!;
    while (!folder.name.startsWith("새 이름") && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    expect(folder.name).toBe(`새 이름 (${board.code})`);
  });

  it("대시보드 최근 글에 첫 사진과 그 보드의 파일 보기 토큰이 온다 (사진 미리보기)", async () => {
    const board = await makeBoard(t, { title: "사진 보드", entryMode: "free" });
    const tok = await freeJoin(board.code, "토끼");
    const a = await connect(board.code, { token: tok });
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const done = await upload(board.code, tok, bytes);
    const ack = await a.ok({ t: "post.save", post: { title: "사진", attachments: [{ uploadToken: done.token }] } });
    await a.ok({ t: "post.save", post: { title: "글만" } });
    await runDurableObjectAlarm(teacherStub(board.id));
    const recent = await t.json<import("../src/shared/protocol").RecentPostsResponse>("GET", "/api/teacher/recent-posts?limit=5");
    const withImg = recent.posts.find((p) => p.postId === ack.result.postId)!;
    const textOnly = recent.posts.find((p) => p.title === "글만")!;
    expect(withImg.hasImage).toBe(true);
    expect(withImg.image).toMatchObject({ width: 40, height: 30 });
    expect(withImg.fileToken).toBeTruthy();
    expect(textOnly.image).toBeUndefined();
    expect(textOnly.fileToken).toBeUndefined();
    expect(JSON.stringify(recent)).not.toContain(done.file.driveFileId);
    const res = await call(`/api/files/${board.id}/${withImg.image!.id}?t=${encodeURIComponent(withImg.fileToken!)}`);
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
    // 토큰은 그 보드에만
    const other = await makeBoard(t, { title: "다른", entryMode: "free" });
    expect((await call(`/api/files/${other.id}/${withImg.image!.id}?t=${encodeURIComponent(withImg.fileToken!)}`)).status).toBe(403);
  });

  it("잠긴 보드에는 학생이 업로드 세션을 만들 수 없다 (getUploadPolicy)", async () => {
    const board = await makeBoard(t, { title: "잠김", entryMode: "free", locked: true });
    const tok = await freeJoin(board.code, "토끼");
    const r = await studentPost(`/api/boards/${board.code}/uploads`, tok, { name: "a.png", size: 3, mime: "image/png" });
    expect(r.status).toBe(403);
    expect(((await r.json()) as { error: { message: string } }).error.message).toContain("잠갔어요");
  });

  it("시트 내보내기용 exportRows 가 교사 보기(실명)로 나온다", async () => {
    const board = await makeBoard(t, { title: "내보내기", entryMode: "free", anonymous: true });
    const a = await connect(board.code, { token: await freeJoin(board.code, "토끼") });
    await a.ok({ t: "post.save", post: { title: "제목", body: "내용" } });
    const rows = await getBoardStub(env, board.id).exportRows();
    expect(rows.header[0]).toBe("열");
    expect(rows.rows[0]).toEqual(expect.arrayContaining(["토끼", "제목", "내용", "게시"]));
  });
});

function teacherStub(id: string) {
  return getBoardStub(env, id);
}
