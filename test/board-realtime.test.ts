import { beforeEach, describe, expect, it } from "vitest";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { resetAll } from "./helpers";
import {
  asTeacher, boardStub, connect, freeJoin, makeBoard, makeClass, newOpId, rosterLogin, ROSTER, type Client, type Teacher,
} from "./board-helpers";
import { setBoardDriveFns, resetBoardDriveFns } from "../src/worker/board";
import type { Board } from "../src/worker/board";
import type { BoardDetail, PostView, TeacherStudent } from "../src/shared/protocol";

let t: Teacher;
beforeEach(async () => {
  await resetAll();
  resetBoardDriveFns();
  // 이 파일은 백업을 보지 않는다: Drive 호출은 조용히 성공
  setBoardDriveFns({ writeBoardBackup: async () => {}, renameBoardFolder: async () => {} });
  t = await asTeacher();
});

interface Room {
  board: BoardDetail;
  students: TeacherStudent[];
  teacher: Client;
  s1: Client; // 김하나 20301
  s2: Client; // 이서준 20302
  s3: Client; // 박지우 20303 (닉네임 별빛)
}

async function room(settings: Record<string, unknown> = {}): Promise<Room> {
  const { class: cls, students } = await makeClass(t, "3학년 1반", ROSTER);
  const board = await makeBoard(t, { title: "관찰 일지", classId: cls.id, ...settings });
  const [k1, k2, k3] = await Promise.all([
    rosterLogin(board.code, "20301", "1357", "4826"),
    rosterLogin(board.code, "20302", "2468", "4827"),
    rosterLogin(board.code, "20303", "3579", "4828"),
  ]);
  const teacher = await connect(board.code, { session: t.session });
  const s1 = await connect(board.code, { token: k1 });
  const s2 = await connect(board.code, { token: k2 });
  const s3 = await connect(board.code, { token: k3 });
  return { board, students, teacher, s1, s2, s3 };
}

const ref = (r: Room, number: string) => r.students.find((s) => s.number === number)!.ref;

describe("스냅숏", () => {
  it("역할에 맞게 걸러진다: 교사는 명단·미제출·백업, 학생은 구성원(닉네임 우선)·파일 토큰", async () => {
    const r = await room();
    const ts = r.teacher.snapshot!;
    expect(ts.me).toEqual({ role: "teacher", ref: "teacher", name: "선생님" });
    expect(ts.roster!.map((m) => m.name)).toEqual(["김하나", "이서준", "박지우"]);
    expect(ts.notSubmitted!.length).toBe(3);
    expect(ts.backup!.state).toBe("never");
    expect(ts.fileToken).toBeTruthy();
    expect(ts.columns.map((c) => c.title)).toEqual(["선생님", "20301 김하나", "20302 이서준", "20303 박지우"]);

    const ss = r.s1.snapshot!;
    expect(ss.me).toMatchObject({ role: "student", name: "김하나", realName: "김하나", number: "20301" });
    expect(ss.roster).toBeUndefined();
    expect(ss.notSubmitted).toBeUndefined();
    expect(ss.backup).toBeUndefined();
    // 닉네임이 있는 학생은 실명 대신 닉네임만 (기존 탭보드 규칙)
    expect(ss.members!.map((m) => m.name)).toEqual(["김하나", "이서준", "별빛"]);
    expect(JSON.stringify(ss)).not.toContain("박지우");
    expect(ss.columns.find((c) => c.mine)!.title).toBe("김하나");
    expect(ss.board.id).toBe(r.board.id);
  });

  it("presence: 접속 수는 모두, 접속자 목록은 교사만", async () => {
    const r = await room();
    const p = await r.teacher.sync();
    expect(p.presence.count).toBe(4);
    expect(p.presence.online!.length).toBe(4);
    const from = r.s1.msgs.length;
    r.s3.close();
    const m = await r.s1.waitFor((x) => x.t === "presence" && x.presence.count === 3, { from });
    expect(m.t === "presence" && m.presence.online).toBeUndefined();
  });

  it("ping 은 자동 응답 pong", async () => {
    const r = await room();
    r.s1.sendRaw("ping");
    const start = Date.now();
    while (!r.s1.raw.includes("pong") && Date.now() - start < 2000) await new Promise((x) => setTimeout(x, 10));
    expect(r.s1.raw).toContain("pong");
  });
});

describe("익명 모드", () => {
  it("학생은 다른 학생의 이름·학번·실제 ref 를 받지 않는다 (카드·댓글·열·구성원)", async () => {
    const r = await room({ anonymous: true });
    const a1 = await r.s1.ok({ t: "post.save", post: { title: "나의 관찰", body: "잎이 자랐다" } });
    await r.s2.ok({ t: "comment.add", postId: a1.result.postId, body: "멋져요" });
    await r.s3.ok({ t: "like.set", postId: a1.result.postId, liked: true });
    await r.teacher.ok({ t: "comment.add", postId: a1.result.postId, body: "잘했어요" });
    const snap2 = await r.s2.sync();
    const snap3 = await r.s3.sync();
    const tsnap = await r.teacher.sync();

    // s2 가 받은 모든 메시지 원문에 김하나/박지우의 실명·학번·ref 가 없다
    const all2 = r.s2.raw.join("\n");
    for (const leak of ["김하나", "20301", "박지우", "별빛", "20303", ref(r, "20301"), ref(r, "20303")]) expect(all2).not.toContain(leak);
    const all3 = r.s3.raw.join("\n");
    for (const leak of ["김하나", "20301", "이서준", "20302", ref(r, "20301"), ref(r, "20302")]) expect(all3).not.toContain(leak);

    const p2 = snap2.posts[0]!;
    expect(p2.authorName).toBe("익명");
    expect(p2.authorRef).toMatch(/^a:/);
    expect(p2.authorNumber).toBeUndefined();
    expect(p2.mine).toBe(false);
    expect(p2.comments.map((c) => [c.authorName, c.mine])).toEqual([["이서준", true], ["선생님", false]]);
    expect(snap2.members).toBeUndefined();
    // 개인별 열 제목·id 도 별칭
    const others = snap2.columns.filter((c) => c.kind === "student" && !c.mine);
    expect(others.every((c) => c.title.startsWith("익명") && c.id.startsWith("s:a:"))).toBe(true);
    expect(p2.columnId).toBe(others.find((c) => c.id === p2.columnId)?.id);
    // 본인은 자기 정보를 받는다
    const own = (await r.s1.sync()).posts[0]!;
    expect(own).toMatchObject({ mine: true, authorName: "김하나", authorNumber: "20301", authorRef: ref(r, "20301") });
    // 교사는 실명
    expect(tsnap.posts[0]).toMatchObject({ authorName: "김하나", authorNumber: "20301" });
    expect(tsnap.posts[0]!.comments[0]!.authorName).toBe("이서준");
    expect(snap3.posts[0]!.likedByMe).toBe(true);
    expect(snap2.posts[0]!.likedByMe).toBe(false);
    expect(snap2.posts[0]!.likeCount).toBe(1);
  });

  it("익명을 켜면 모두에게 새 스냅숏, 별칭은 켤 때마다 바뀐다", async () => {
    const r = await room();
    await r.s1.ok({ t: "post.save", post: { body: "안녕" } });
    const from = r.s2.msgs.length;
    await r.teacher.ok({ t: "settings.update", patch: { anonymous: true } });
    const m = await r.s2.waitFor((x) => x.t === "snapshot", { from });
    const alias1 = m.t === "snapshot" ? m.snapshot.posts[0]!.authorRef : "";
    expect(alias1).toMatch(/^a:/);
    await r.teacher.ok({ t: "settings.update", patch: { anonymous: false } });
    expect((await r.s2.sync()).posts[0]!.authorName).toBe("김하나");
    await r.teacher.ok({ t: "settings.update", patch: { anonymous: true } });
    const alias2 = (await r.s2.sync()).posts[0]!.authorRef;
    expect(alias2).toMatch(/^a:/);
    expect(alias2).not.toBe(alias1);
  });
});

describe("승인 후 게시·숨김", () => {
  it("pending 카드는 작성자와 교사만, 승인하면 모두에게, 숨기면 다시 빠진다", async () => {
    const r = await room({ moderation: true });
    const ack = await r.s1.ok({ t: "post.save", post: { body: "승인 기다림" } });
    const id = ack.result.postId!;
    const tp = await r.teacher.waitFor((m) => m.t === "post.upsert" && m.post.id === id);
    expect(tp.t === "post.upsert" && tp.post.status).toBe("pending");
    expect(r.s1.posts.get(id)!.status).toBe("pending");
    await r.s2.sync();
    expect(r.s2.posts.has(id)).toBe(false);
    expect(r.s2.raw.join("")).not.toContain("승인 기다림");
    // 교사 화면 미제출 목록에서 빠짐
    const sub = await r.teacher.waitFor((m) => m.t === "submission");
    expect(sub.t === "submission" && sub.notSubmitted).not.toContain(ref(r, "20301"));

    // 학생은 승인 못 함
    const no = await r.s1.op({ t: "post.moderate", postId: id, action: "approve" });
    expect(no.t === "error" && no.code).toBe("forbidden");

    await r.teacher.ok({ t: "post.moderate", postId: id, action: "approve" });
    await r.s2.waitFor((m) => m.t === "post.upsert" && m.post.id === id);
    expect(r.s2.posts.get(id)!.status).toBe("visible");

    // 학생이 고치면 다시 승인 대기 → 다른 학생에게서 빠짐
    const from = r.s2.msgs.length;
    await r.s1.ok({ t: "post.save", post: { id, body: "고쳤어요" } });
    await r.s2.waitFor((m) => m.t === "post.remove" && m.postId === id, { from });
    await r.teacher.ok({ t: "post.moderate", postId: id, action: "approve" });
    await r.s2.waitFor((m) => m.t === "post.upsert" && m.post.id === id && m.post.body === "고쳤어요");

    // 숨기기
    const f2 = r.s2.msgs.length;
    await r.teacher.ok({ t: "post.moderate", postId: id, action: "hide" });
    await r.s2.waitFor((m) => m.t === "post.remove" && m.postId === id, { from: f2 });
    await r.s1.waitFor((m) => m.t === "post.upsert" && m.post.id === id && m.post.status === "hidden");
    // 숨긴 카드에는 다른 학생이 댓글·좋아요 못 함 (존재도 모름)
    const c = await r.s2.op({ t: "comment.add", postId: id, body: "보여?" });
    expect(c.t === "error" && c.code).toBe("not_found");
    const l = await r.s3.op({ t: "like.set", postId: id, liked: true });
    expect(l.t === "error" && l.code).toBe("not_found");
    await r.teacher.ok({ t: "post.moderate", postId: id, action: "unhide" });
    await r.s2.waitFor((m) => m.t === "post.upsert" && m.post.id === id && m.post.status === "visible");
  });

  it("교사 카드는 승인 없이 바로 게시", async () => {
    const r = await room({ moderation: true });
    const ack = await r.teacher.ok({ t: "post.save", post: { title: "예시" } });
    await r.s2.waitFor((m) => m.t === "post.upsert" && m.post.id === ack.result.postId && m.post.columnId === "teacher");
  });
});

describe("피드백", () => {
  it("작성자와 교사에게만, 다른 학생에게는 피드백이 담긴 메시지조차 가지 않는다", async () => {
    const r = await room();
    const id = (await r.s1.ok({ t: "post.save", post: { body: "관찰" } })).result.postId!;
    await r.s2.waitFor((m) => m.t === "post.upsert" && m.post.id === id);
    const before2 = r.s2.msgs.length;
    await r.teacher.ok({ t: "feedback.set", postId: id, body: "관찰을 더 자세히 써 보자" });
    const m1 = await r.s1.waitFor((m) => m.t === "post.upsert" && !!m.post.feedback);
    expect(m1.t === "post.upsert" && m1.post.feedback!.body).toBe("관찰을 더 자세히 써 보자");
    const snap2 = await r.s2.sync();
    expect(r.s2.msgs.slice(before2).filter((m) => m.t === "post.upsert").length).toBe(0);
    expect(snap2.posts[0]!.feedback).toBeUndefined();
    expect(r.s2.raw.join("")).not.toContain("자세히");
    expect((await r.teacher.sync()).posts[0]!.feedback!.body).toContain("자세히");
    // 학생은 피드백을 못 씀
    const no = await r.s2.op({ t: "feedback.set", postId: id, body: "x" });
    expect(no.t === "error" && no.code).toBe("forbidden");
    // 지우기
    await r.teacher.ok({ t: "feedback.set", postId: id, body: "" });
    expect((await r.s1.sync()).posts[0]!.feedback).toBeUndefined();
  });
});

describe("보드 유형·잠금·권한", () => {
  it("단일 주제: 학생당 카드 1장 (교사는 예외), 여러 장 쓴 학생이 있으면 단일로 못 바꿈", async () => {
    const r = await room({ type: "single" });
    const first = await r.s1.ok({ t: "post.save", post: { body: "1" } });
    const second = await r.s1.op({ t: "post.save", post: { body: "2" } });
    expect(second.t === "error" && second.code).toBe("one_card_only");
    // 고치기는 가능
    await r.s1.ok({ t: "post.save", post: { id: first.result.postId, body: "1-수정" } });
    await r.teacher.ok({ t: "post.save", post: { body: "교사 1" } });
    await r.teacher.ok({ t: "post.save", post: { body: "교사 2" } });
    // 교사가 학생 대신 쓰는 것도 1장 규칙
    const behalf = await r.teacher.op({ t: "post.save", post: { body: "대신", onBehalfOf: ref(r, "20301") } });
    expect(behalf.t === "error" && behalf.code).toBe("one_card_only");
    await r.teacher.ok({ t: "post.save", post: { body: "대신", onBehalfOf: ref(r, "20302") } });
    // s2 는 교사가 대신 쓴 카드를 자기 카드로 받는다
    const own = (await r.s2.sync()).posts.find((p) => p.body === "대신")!;
    expect(own.mine).toBe(true);

    await r.teacher.ok({ t: "settings.update", patch: { type: "cumulative" } });
    await r.s1.ok({ t: "post.save", post: { body: "2" } });
    const back = await r.teacher.op({ t: "settings.update", patch: { type: "single" } });
    expect(back.t === "error" && back.code).toBe("invalid_settings");
  });

  it("잠금: 학생은 쓰기·댓글·좋아요·삭제 불가, 교사는 가능, 풀면 다시", async () => {
    const r = await room();
    const id = (await r.s1.ok({ t: "post.save", post: { body: "잠그기 전" } })).result.postId!;
    const from = r.s2.msgs.length;
    await r.teacher.ok({ t: "settings.update", patch: { locked: true } });
    const su = await r.s2.waitFor((m) => m.t === "settings.update", { from });
    expect(su.t === "settings.update" && su.settings.locked).toBe(true);
    for (const op of [
      { t: "post.save", post: { body: "x" } },
      { t: "post.save", post: { id, body: "x" } },
      { t: "post.delete", postId: id },
      { t: "comment.add", postId: id, body: "x" },
      { t: "like.set", postId: id, liked: true },
    ] as const) {
      const res = await r.s1.op(op as never);
      expect(res.t === "error" && res.code, JSON.stringify(op)).toBe("locked");
    }
    await r.teacher.ok({ t: "comment.add", postId: id, body: "교사는 됨" });
    expect(await boardStub(r.board.id).getUploadPolicy({ role: "student", ref: ref(r, "20301"), name: "", boardId: r.board.id, code: r.board.code })).toEqual({
      ok: false, reason: expect.stringContaining("잠갔어요"),
    });
    await r.teacher.ok({ t: "settings.update", patch: { locked: false } });
    await r.s1.ok({ t: "comment.add", postId: id, body: "다시 됨" });
  });

  it("남의 카드·댓글은 못 고치고 못 지운다, 교사는 지울 수 있다", async () => {
    const r = await room();
    const id = (await r.s1.ok({ t: "post.save", post: { body: "내 것" } })).result.postId!;
    const e1 = await r.s2.op({ t: "post.save", post: { id, body: "남의 것 고침" } });
    expect(e1.t === "error" && e1.code).toBe("forbidden");
    const e2 = await r.s2.op({ t: "post.delete", postId: id });
    expect(e2.t === "error" && e2.code).toBe("forbidden");
    const cid = (await r.s1.ok({ t: "comment.add", postId: id, body: "댓글" })).result.commentId!;
    const e3 = await r.s2.op({ t: "comment.delete", postId: id, commentId: cid });
    expect(e3.t === "error" && e3.code).toBe("forbidden");
    await r.teacher.ok({ t: "comment.delete", postId: id, commentId: cid });
    await r.s2.waitFor((m) => m.t === "comment.remove" && m.commentId === cid);
    await r.teacher.ok({ t: "post.delete", postId: id });
    await r.s2.waitFor((m) => m.t === "post.remove" && m.postId === id);
    // 학생 전용이 아닌 교사 전용 작업
    for (const op of [
      { t: "notice.save", notice: { title: "x", body: "" } },
      { t: "settings.update", patch: { locked: true } },
    ] as const) {
      const res = await r.s1.op(op as never);
      expect(res.t === "error" && res.code).toBe("forbidden");
    }
  });

  it("댓글·좋아요 끄기", async () => {
    const r = await room({ allowComments: false, allowLikes: false });
    const id = (await r.s1.ok({ t: "post.save", post: { body: "x" } })).result.postId!;
    const c = await r.s2.op({ t: "comment.add", postId: id, body: "x" });
    expect(c.t === "error" && c.code).toBe("comments_disabled");
    const l = await r.s2.op({ t: "like.set", postId: id, liked: true });
    expect(l.t === "error" && l.code).toBe("likes_disabled");
  });
});

describe("검증·속도 제한·멱등", () => {
  it("크기·형식 검증 (한국어 오류)", async () => {
    const r = await room();
    const big = await r.s1.op({ t: "post.save", post: { body: "가".repeat(5001) } });
    expect(big.t === "error" && big.code).toBe("too_large");
    expect(big.t === "error" && big.message).toContain("5000자");
    const empty = await r.s1.op({ t: "post.save", post: { title: "  " } });
    expect(empty.t === "error" && empty.code).toBe("empty_post");
    const badLink = await r.s1.op({ t: "post.save", post: { link: "javascript:alert(1)" } });
    expect(badLink.t === "error" && badLink.code).toBe("bad_request");
    const tooMany = await r.s1.op({ t: "post.save", post: { body: "x", attachments: Array(6).fill({ uploadToken: "x" }) } });
    expect(tooMany.t === "error" && tooMany.code).toBe("limit_reached");
    const badUpload = await r.s1.op({ t: "post.save", post: { body: "x", attachments: [{ uploadToken: "forged.token" }] } });
    expect(badUpload.t === "error" && badUpload.code).toBe("invalid_upload");
    // opId 없음, JSON 아님, 너무 큰 메시지
    let from = r.s1.msgs.length;
    r.s1.sendRaw(JSON.stringify({ t: "post.save", post: { body: "x" } }));
    expect((await r.s1.waitFor((m) => m.t === "error", { from })).t).toBe("error");
    from = r.s1.msgs.length;
    r.s1.sendRaw("{nope");
    const e = await r.s1.waitFor((m) => m.t === "error", { from });
    expect(e.t === "error" && e.code).toBe("bad_request");
    from = r.s1.msgs.length;
    r.s1.sendRaw(JSON.stringify({ t: "post.save", opId: newOpId(), post: { body: "x".repeat(70_000) } }));
    const e2 = await r.s1.waitFor((m) => m.t === "error", { from });
    expect(e2.t === "error" && e2.code).toBe("too_large");
  });

  it("같은 opId 를 다시 보내면 한 번만 적용 (메모리 캐시를 잃은 뒤에도)", async () => {
    const r = await room();
    const opId = newOpId();
    const a1 = await r.s1.ok({ t: "post.save", post: { body: "한 번만" } }, opId);
    const a2 = await r.s1.ok({ t: "post.save", post: { body: "한 번만" } }, opId);
    expect(a2.result).toEqual({ postId: a1.result.postId, duplicate: true });
    // DO 를 내보내 메모리를 비운 뒤 재전송 (재접속 후 재전송 상황)
    await evictDurableObject(boardStub(r.board.id));
    const a3 = await r.s1.ok({ t: "post.save", post: { body: "한 번만" } }, opId);
    expect(a3.result).toEqual({ postId: a1.result.postId, duplicate: true });
    const cop = newOpId();
    const c1 = await r.s2.ok({ t: "comment.add", postId: a1.result.postId, body: "댓글" }, cop);
    await evictDurableObject(boardStub(r.board.id));
    const c2 = await r.s2.ok({ t: "comment.add", postId: a1.result.postId, body: "댓글" }, cop);
    expect(c2.result.commentId).toBe(c1.result.commentId);
    // 좋아요는 상태를 보내므로 여러 번 보내도 1
    await r.s2.ok({ t: "like.set", postId: a1.result.postId, liked: true });
    await r.s2.ok({ t: "like.set", postId: a1.result.postId, liked: true });
    const snap = await r.teacher.sync();
    expect(snap.posts.length).toBe(1);
    expect(snap.posts[0]!.comments.length).toBe(1);
    expect(snap.posts[0]!.likeCount).toBe(1);
    // 다른 학생이 같은 opId 를 써도 남의 카드와 섞이지 않음
    const other = await r.s3.ok({ t: "post.save", post: { body: "다른 사람" } }, opId);
    expect(other.result.postId).not.toBe(a1.result.postId);
    expect(other.result.duplicate).toBeUndefined();
  });

  it("연결당 속도 제한", async () => {
    const r = await room();
    const from = r.s1.msgs.length;
    for (let i = 0; i < 30; i++) r.s1.sendRaw(JSON.stringify({ t: "like.set", opId: newOpId(), postId: "pnope", liked: true }));
    const limited = await r.s1.waitFor((m) => m.t === "error" && m.code === "rate_limited", { from });
    expect(limited.t === "error" && limited.retryAfterMs).toBeGreaterThan(0);
  });
});

describe("열", () => {
  it("주제별 열: 교사 만들기·이름 바꾸기·순서·삭제, 학생은 열을 골라 씀", async () => {
    const r = await room({ columnMode: "topic" });
    const cols0 = r.s1.snapshot!.columns;
    expect(cols0.map((c) => c.title)).toEqual(["주제 1"]);
    const k2 = (await r.teacher.ok({ t: "column.save", column: { title: "질문" } })).result.columnId!;
    await r.s1.waitFor((m) => m.t === "columns.set" && m.columns.length === 2);
    const noCol = await r.s1.op({ t: "post.save", post: { body: "x" } });
    expect(noCol.t === "error" && noCol.code).toBe("column_required");
    const pid = (await r.s1.ok({ t: "post.save", post: { body: "질문 있어요", columnId: k2 } })).result.postId!;
    expect(r.s1.posts.get(pid)?.columnId ?? (await r.s1.sync()).posts[0]!.columnId).toBe(k2);
    const del = await r.teacher.op({ t: "column.delete", columnId: k2 });
    expect(del.t === "error" && del.code).toBe("column_not_empty");
    await r.teacher.ok({ t: "column.save", column: { id: k2, title: "궁금한 점" } });
    await r.teacher.ok({ t: "column.reorder", order: [k2, cols0[0]!.id] });
    const m = await r.s2.waitFor((x) => x.t === "columns.set" && x.columns[0]!.id === k2);
    expect(m.t === "columns.set" && m.columns[0]!.title).toBe("궁금한 점");
    const stu = await r.s1.op({ t: "column.save", column: { title: "x" } });
    expect(stu.t === "error" && stu.code).toBe("forbidden");
    // 카드를 옮긴 뒤 빈 열 삭제
    await r.s1.ok({ t: "post.save", post: { id: pid, columnId: cols0[0]!.id } });
    await r.teacher.ok({ t: "column.delete", columnId: k2 });
    expect((await r.s2.sync()).columns.length).toBe(1);
  });

  it("모둠별 열: 명단의 모둠으로 열이 생기고 카드는 작성자 모둠에", async () => {
    const r = await room({ columnMode: "group" });
    expect(r.s1.snapshot!.columns.map((c) => c.title)).toEqual(["선생님", "1모둠", "2모둠"]);
    expect(r.s1.snapshot!.columns.find((c) => c.mine)!.title).toBe("1모둠");
    await r.s3.ok({ t: "post.save", post: { body: "2모둠 카드" } });
    const snap = await r.s1.sync();
    expect(snap.posts[0]!.columnId).toBe("g:2모둠");
  });

  it("자유 입장 + 개인별: 들어온 학생마다 열이 생긴다", async () => {
    const board = await makeBoard(t, { title: "자유", entryMode: "free" });
    const tk = await freeJoin(board.code, "토끼");
    const a = await connect(board.code, { token: tk });
    expect(a.snapshot!.columns.map((c) => c.title)).toEqual(["선생님", "토끼"]);
    const from = a.msgs.length;
    await freeJoin(board.code, "거북");
    const m = await a.waitFor((x) => x.t === "columns.set", { from });
    expect(m.t === "columns.set" && m.columns.map((c) => c.title)).toEqual(["선생님", "토끼", "거북"]);
  });
});

describe("미제출·공지", () => {
  it("교사에게 아직 카드가 없는 학생 목록, 공지는 모두에게", async () => {
    const r = await room();
    await r.s2.ok({ t: "post.save", post: { body: "제출" } });
    const sub = await r.teacher.waitFor((m) => m.t === "submission");
    expect(sub.t === "submission" && sub.notSubmitted.sort()).toEqual([ref(r, "20301"), ref(r, "20303")].sort());
    expect(r.s1.msgs.some((m) => m.t === "submission")).toBe(false);
    const nid = (await r.teacher.ok({ t: "notice.save", notice: { title: "오늘 할 일", body: "관찰 쓰기" } })).result.noticeId!;
    await r.s1.waitFor((m) => m.t === "notice.upsert" && m.notice.id === nid);
    await r.teacher.ok({ t: "notice.delete", noticeId: nid });
    await r.s3.waitFor((m) => m.t === "notice.remove" && m.noticeId === nid);
  });
});

describe("hibernation", () => {
  it("DO 를 내보낸 뒤에도 연결의 접속자 정보·속도 제한이 남고 쓰기·방송이 된다", async () => {
    const r = await room();
    await r.s1.ok({ t: "post.save", post: { body: "전" } });
    await evictDurableObject(boardStub(r.board.id));
    // 메모리 캐시가 비었는지 확인
    const wasFresh = await runInDurableObject(boardStub(r.board.id), (inst: Board) => (inst as unknown as { model: unknown }).model === null);
    expect(wasFresh).toBe(true);
    const ack = await r.s2.ok({ t: "post.save", post: { body: "후" } });
    const m = await r.s1.waitFor((x) => x.t === "post.upsert" && x.post.id === ack.result.postId);
    expect(m.t === "post.upsert" && (m.post as PostView).authorName).toBe("이서준");
    // 학생 권한도 그대로 (교사 작업은 거부)
    const no = await r.s2.op({ t: "notice.save", notice: { title: "x", body: "" } });
    expect(no.t === "error" && no.code).toBe("forbidden");
    const snap = await r.teacher.sync();
    expect(snap.posts.map((p) => p.body)).toEqual(["전", "후"]);
    expect(snap.presence.count).toBe(4);
  });
});
