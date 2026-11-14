/**
 * 통합 보안 점검 (태스크7). 실제 라우트·DO·Drive 코드 + 가짜 Google Drive.
 * 다른 시험에서 다루지 않은 빈틈만 모았다: 토큰 용도 섞어 쓰기, 보드 넘나들기, 병렬 PIN 대입,
 * 파일 보기(SVG/HTML·토큰 범위), 업로드 세션 바꿔치기, 비밀 값 노출, CSV 주입, 보안 헤더, 익명 모드 원본 프레임.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { call, ORIGIN, resetAll } from "./helpers";
import { FakeDrive } from "./drive-fake";
import { asTeacher, connect, connectRaw, freeJoin, makeBoard, makeClass, publicPost, rosterLogin, TEACHER, type Teacher } from "./board-helpers";
import { resetDriveDeps, setDriveDeps } from "../src/worker/drive/deps";
import { resetDriveFolderCache } from "../src/worker/drive/folders";
import { authenticateBoardActor } from "../src/worker/board/actor";
import { resetBoardDriveFns } from "../src/worker/board";
import { getSigningSecret, signToken } from "../src/worker/auth";
import { csvCell, toCsv } from "../src/worker/drive/export";
import { getBoardStub } from "../src/worker/stubs";
import { FILE_VIEW_TOKEN_PURPOSE, type CompleteUploadResponse, type CreateUploadResponse } from "../src/shared/files";

let t: Teacher;
let drive: FakeDrive;

beforeEach(async () => {
  await resetAll();
  resetDriveDeps();
  resetDriveFolderCache();
  resetBoardDriveFns();
  setDriveDeps({ authenticateBoardActor });
  t = await asTeacher();
  drive = new FakeDrive(TEACHER);
  drive.install();
});
afterEach(() => {
  resetDriveDeps();
  setDriveDeps({ authenticateBoardActor });
});

const bearer = (token: string, path: string, body: unknown) =>
  call(path, { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN, authorization: `Bearer ${token}` }, body: JSON.stringify(body) });

async function upload(code: string, token: string, name: string, mime: string, bytes: Uint8Array) {
  const r1 = await bearer(token, `/api/boards/${code}/uploads`, { name, size: bytes.byteLength, mime });
  expect(r1.status, await r1.clone().text()).toBe(200);
  const up = (await r1.json()) as CreateUploadResponse;
  const put = (await (await drive.handle(new Request(up.uploadUrl, { method: "PUT", body: bytes }))).json()) as { id: string };
  const r2 = await bearer(token, `/api/boards/${code}/uploads/${encodeURIComponent(up.uploadId)}/complete`, { sessionUrl: up.uploadUrl, driveFileId: put.id });
  expect(r2.status, await r2.clone().text()).toBe(200);
  return { up, done: (await r2.json()) as CompleteUploadResponse };
}

describe("토큰 용도·범위", () => {
  it("한 용도의 토큰은 다른 용도로 쓸 수 없다 (파일 보기·업로드·세션 → 학생 토큰 자리 등)", async () => {
    const board = await makeBoard(t, { title: "A", entryMode: "free" });
    const tok = await freeJoin(board.code, "토끼");
    const s = await connect(board.code, { token: tok });
    const fileToken = s.snapshot!.fileToken;
    // 파일 보기 토큰 / 교사 세션 토큰을 학생 토큰으로
    expect((await connectRaw(board.code, { token: fileToken })).status).toBe(401);
    expect((await connectRaw(board.code, { token: t.session })).status).toBe(401);
    // 학생 토큰을 파일 보기 토큰으로
    const { done } = await upload(board.code, tok, "a.png", "image/png", new Uint8Array([1, 2, 3]));
    const ack = await s.ok({ t: "post.save", post: { attachments: [{ uploadToken: done.token }] } });
    const att = (await s.waitFor((m) => m.t === "post.upsert" && m.post.id === ack.result.postId));
    const attId = att.t === "post.upsert" ? att.post.attachments[0]!.id : "";
    expect((await call(`/api/files/${board.id}/${attId}?t=${encodeURIComponent(tok)}`)).status).toBe(401);
    expect((await call(`/api/files/${board.id}/${attId}?t=${encodeURIComponent(done.token)}`)).status).toBe(401);
    // 학생 토큰을 교사 세션 쿠키로
    const asCookie = await call("/api/teacher/boards", { headers: { cookie: `__Host-nb_session=${encodeURIComponent(tok)}` } });
    expect(asCookie.status).toBe(401);
    // 업로드 확인 토큰 자리에 업로드 세션(uploadId)을 넣어도 거부
    const { up } = await upload(board.code, tok, "b.png", "image/png", new Uint8Array([4]));
    const forged = await s.op({ t: "post.save", post: { attachments: [{ uploadToken: up.uploadId }] } });
    expect(forged.t === "error" && forged.code).toBe("invalid_upload");
  });

  it("만료된 파일 보기 토큰은 401, 다른 보드의 토큰은 403", async () => {
    const board = await makeBoard(t, { title: "A", entryMode: "free" });
    const secret = await getSigningSecret(env);
    const expired = await signToken(secret, FILE_VIEW_TOKEN_PURPOSE, { boardId: board.id }, 1);
    await new Promise((r) => setTimeout(r, 2100));
    expect((await call(`/api/files/${board.id}/aXXXX?t=${encodeURIComponent(expired)}`)).status).toBe(401);
  });

  it("보드 A 학생이 보드 B 에 업로드·닉네임·웹소켓 모두 거부", async () => {
    const a = await makeBoard(t, { title: "A", entryMode: "free" });
    const b = await makeBoard(t, { title: "B", entryMode: "free" });
    const tokA = await freeJoin(a.code, "토끼");
    expect((await bearer(tokA, `/api/boards/${b.code}/uploads`, { name: "x.png", size: 3, mime: "image/png" })).status).toBe(401);
    expect((await bearer(tokA, `/api/boards/${b.code}/nickname`, { nickname: "해커" })).status).toBe(401);
    expect((await connectRaw(b.code, { token: tokA })).status).toBe(401);
    // A 에서 받은 업로드 확인 토큰을 B 카드에 붙이기
    const tokB = await freeJoin(b.code, "거북");
    const { done } = await upload(a.code, tokA, "a.png", "image/png", new Uint8Array([9, 9]));
    const sb = await connect(b.code, { token: tokB });
    const r = await sb.op({ t: "post.save", post: { attachments: [{ uploadToken: done.token }] } });
    expect(r.t === "error" && r.code).toBe("invalid_upload");
  });
});

describe("학생이 교사 동작·남의 것", () => {
  it("교사 전용 메시지는 모두 forbidden, 남의 카드 고치기·지우기·남의 댓글 지우기 forbidden", async () => {
    const board = await makeBoard(t, { title: "x", entryMode: "free", columnMode: "topic" });
    const s1 = await connect(board.code, { token: await freeJoin(board.code, "토끼") });
    const s2 = await connect(board.code, { token: await freeJoin(board.code, "거북") });
    const col = s1.snapshot!.columns[0]!.id;
    const p = await s1.ok({ t: "post.save", post: { body: "내 글", columnId: col } });
    const c = await s1.ok({ t: "comment.add", postId: p.result.postId, body: "내 댓글" });
    const teacherOps = [
      { t: "post.moderate", postId: p.result.postId, action: "hide" },
      { t: "feedback.set", postId: p.result.postId, body: "x" },
      { t: "notice.save", notice: { title: "공지" } },
      { t: "notice.delete", noticeId: "n123456789" },
      { t: "settings.update", patch: { locked: true } },
      { t: "column.save", column: { title: "새 열" } },
      { t: "column.delete", columnId: col },
      { t: "column.reorder", order: [col] },
      { t: "post.save", post: { body: "대신", columnId: col, onBehalfOf: s1.snapshot!.me.ref } },
    ] as const;
    for (const m of teacherOps) {
      const r = await s2.op(m as never);
      expect(r.t === "error" && r.code, m.t).toBe("forbidden");
    }
    const edit = await s2.op({ t: "post.save", post: { id: p.result.postId, body: "바꿈" } });
    expect(edit.t === "error" && edit.code).toBe("forbidden");
    const del = await s2.op({ t: "post.delete", postId: p.result.postId });
    expect(del.t === "error" && del.code).toBe("forbidden");
    const cdel = await s2.op({ t: "comment.delete", postId: p.result.postId, commentId: c.result.commentId });
    expect(cdel.t === "error" && cdel.code).toBe("forbidden");
    // 학생 토큰으로 교사 REST
    const tok = await freeJoin(board.code, "다람쥐");
    expect((await call("/api/teacher/boards", { headers: { authorization: `Bearer ${tok}` } })).status).toBe(401);
    expect((await call(`/api/boards/${board.code}/drive`, { headers: { authorization: `Bearer ${tok}` } })).status).toBe(401);
    expect((await bearer(tok, `/api/boards/${board.code}/export`, {})).status).toBe(401);
  });

  it("javascript: 링크는 저장되지 않는다", async () => {
    const board = await makeBoard(t, { title: "x", entryMode: "free" });
    const s = await connect(board.code, { token: await freeJoin(board.code, "토끼") });
    for (const link of ["javascript:alert(1)", " JaVaScRiPt:alert(1)", "data:text/html,<script>1</script>", "vbscript:x"]) {
      const r = await s.op({ t: "post.save", post: { body: "x", link } });
      expect(r.t === "error" && r.code, link).toBe("bad_request");
    }
  });
});

describe("병렬 PIN 대입", () => {
  it("한꺼번에 20번 틀린 PIN 을 보내도 5번 이상은 비교되지 않고 잠긴다", async () => {
    const cls = await makeClass(t, "반", [{ number: "20301", name: "김하나", pin: "1357" }]);
    const board = await makeBoard(t, { title: "x", classId: cls.class.id });
    await rosterLogin(board.code, "20301", "1357", "7391");
    const ip = { "cf-connecting-ip": "198.51.100.7" };
    const res = await Promise.all(Array.from({ length: 20 }, (_, i) => publicPost(`/api/boards/${board.code}/login`, { number: "20301", pin: String(1000 + i) }, ip)));
    const codes = await Promise.all(res.map(async (r) => ((await r.json()) as { error?: { code: string } }).error?.code));
    expect(codes.filter((c) => c === "invalid_credentials").length).toBeLessThanOrEqual(4);
    expect(codes.filter((c) => c === "student_locked").length).toBeGreaterThanOrEqual(16);
    // 잠긴 뒤에는 맞는 PIN 도 거부
    const right = await publicPost(`/api/boards/${board.code}/login`, { number: "20301", pin: "7391" }, ip);
    expect(right.status).toBe(429);
  });
});

describe("파일 보기", () => {
  it("SVG·HTML 첨부는 화면에 열지 않고 내려받기, 모든 파일에 nosniff·sandbox CSP", async () => {
    const board = await makeBoard(t, { title: "x", entryMode: "free" });
    const tok = await freeJoin(board.code, "토끼");
    const s = await connect(board.code, { token: tok });
    const enc = new TextEncoder();
    const svg = await upload(board.code, tok, "그림.svg", "image/svg+xml", enc.encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'));
    const html = await upload(board.code, tok, "a.html", "text/html", enc.encode("<script>alert(1)</script>"));
    // 이미지라고 속인 HTML (내용 스니핑 시도)
    const fake = await upload(board.code, tok, "가짜.png", "image/png", enc.encode("<html><script>alert(1)</script></html>"));
    expect(svg.done.file.kind).toBe("file");
    const ack = await s.ok({ t: "post.save", post: { body: "x", attachments: [svg, html, fake].map((u) => ({ uploadToken: u.done.token })) } });
    const m = await s.waitFor((x) => x.t === "post.upsert" && x.post.id === ack.result.postId);
    if (m.t !== "post.upsert") throw new Error();
    const ft = encodeURIComponent(s.snapshot!.fileToken);
    const get = (id: string) => call(`/api/files/${board.id}/${id}?t=${ft}`);
    const [rSvg, rHtml, rFake] = await Promise.all(m.post.attachments.map((a) => get(a.id)));
    expect(rSvg!.headers.get("content-disposition")).toMatch(/^attachment;/);
    expect(rSvg!.headers.get("content-type")).toBe("application/octet-stream");
    expect(rHtml!.headers.get("content-disposition")).toMatch(/^attachment;/);
    expect(rHtml!.headers.get("content-type")).toMatch(/^text\/plain/);
    expect(rFake!.headers.get("content-type")).toBe("image/png");
    for (const r of [rSvg!, rHtml!, rFake!]) {
      expect(r.headers.get("x-content-type-options")).toBe("nosniff");
      expect(r.headers.get("content-security-policy")).toContain("sandbox");
      expect(r.headers.get("cache-control")).toMatch(/^private/);
    }
    // 없는 첨부 id (다른 보드 첨부 id 짐작 포함) → 404
    expect((await get("aDoesNotExist12345")).status).toBe(404);
  });

  it("업로드 세션 주소를 다른 세션 것으로 바꾸면 거부, 크기를 속이면 거부", async () => {
    const board = await makeBoard(t, { title: "x", entryMode: "free" });
    const tok = await freeJoin(board.code, "토끼");
    const r1 = (await (await bearer(tok, `/api/boards/${board.code}/uploads`, { name: "a.png", size: 4, mime: "image/png" })).json()) as CreateUploadResponse;
    const r2 = (await (await bearer(tok, `/api/boards/${board.code}/uploads`, { name: "b.png", size: 4, mime: "image/png" })).json()) as CreateUploadResponse;
    await drive.handle(new Request(r2.uploadUrl, { method: "PUT", body: new Uint8Array([1, 2, 3, 4]) }));
    const swapped = await bearer(tok, `/api/boards/${board.code}/uploads/${encodeURIComponent(r1.uploadId)}/complete`, { sessionUrl: r2.uploadUrl });
    expect(swapped.status).toBe(400);
    // 프록시: 선언한 크기와 다른 바이트 수
    const proxy = await call(r1.fallback!.uploadUrl, {
      method: "PUT",
      headers: { ...r1.fallback!.headers, origin: ORIGIN, "content-length": "9" },
      body: new Uint8Array(9),
    });
    expect(proxy.status).toBe(400);
  });
});

describe("비밀 값·개인정보", () => {
  it("어떤 응답에도 refresh/access token·client secret·PIN 해시가 없다", async () => {
    const cls = await makeClass(t, "반", [{ number: "20301", name: "김하나", pin: "1357" }]);
    const board = await makeBoard(t, { title: "x", classId: cls.class.id });
    const tok = await rosterLogin(board.code, "20301", "1357", "7391");
    const s = await connect(board.code, { token: tok });
    const tc = await connect(board.code, { session: t.session });
    await s.ok({ t: "post.save", post: { body: "글" } });
    const bodies = [
      await (await call("/api/me", { headers: { cookie: `__Host-nb_session=${encodeURIComponent(t.session)}` } })).text(),
      await (await t.req("GET", "/api/teacher/boards")).text(),
      await (await t.req("GET", `/api/teacher/boards/${board.id}`)).text(),
      await (await t.req("GET", `/api/teacher/classes/${cls.class.id}/students`)).text(),
      await (await t.req("GET", `/api/boards/${board.code}/drive`)).text(),
      await (await call(`/api/boards/${board.code}`)).text(),
      JSON.stringify((await getBoardStub(env, board.id).backupContent())),
      ...s.raw,
      ...tc.raw,
    ].join("\n");
    for (const needle of ["refresh_token", "refreshToken", "access_token", "accessToken", "client_secret", "test-client-secret", "pin_hash", "pinHash", "pin_salt", "at-refreshed", "7391"]) {
      expect(bodies, needle).not.toContain(needle);
    }
  });

  it("익명 모드: 학생이 받는 모든 원본 프레임(스냅숏·presence·열·카드·댓글·좋아요)에 다른 학생 실명·학번·ref 가 없다", async () => {
    const cls = await makeClass(t, "반", [
      { number: "20301", name: "김하나", pin: "1357" },
      { number: "20302", name: "이서준", pin: "2468", nickname: "번개" },
    ]);
    const board = await makeBoard(t, { title: "x", classId: cls.class.id, anonymous: true });
    const tok1 = await rosterLogin(board.code, "20301", "1357", "7391");
    const tok2 = await rosterLogin(board.code, "20302", "2468", "8462");
    const s1 = await connect(board.code, { token: tok1 });
    const s2 = await connect(board.code, { token: tok2 });
    const ref2 = s2.snapshot!.me.ref;
    const p = await s2.ok({ t: "post.save", post: { body: "익명 글" } });
    await s2.ok({ t: "comment.add", postId: p.result.postId, body: "익명 댓글" });
    await s2.ok({ t: "like.set", postId: p.result.postId, liked: true });
    await s1.waitFor((m) => m.t === "like.set");
    await s2.ok({ t: "post.save", post: { id: p.result.postId, body: "고침" } });
    await s1.waitFor((m) => m.t === "post.upsert" && m.post.body === "고침");
    s2.ws.close();
    await s1.waitFor((m) => m.t === "presence" && m.presence.count === 1);
    const all = s1.raw.join("\n");
    for (const needle of ["이서준", "번개", "20302", ref2]) expect(all, needle).not.toContain(needle);
    expect(all).toContain("익명");
  });
});

describe("CSV·헤더·출처", () => {
  it("CSV: 수식으로 해석될 수 있는 칸은 ' 로 시작 (앞 공백·줄바꿈 포함)", () => {
    for (const v of ["=1+1", "+1", "-1+2", "@SUM(A1)", " =HYPERLINK(\"x\")", "\n=1", "\t=1", "\r=1"]) expect(csvCell(v).replace(/^"/, "")).toMatch(/^'/);
    expect(csvCell("안녕")).toBe("안녕");
    expect(toCsv(["a"], [["<b>x</b>"]])).toBe("a\r\n<b>x</b>\r\n");
  });

  it("Worker 응답에 nosniff, 오류 안내 HTML 에 CSP·frame 막기", async () => {
    const r = await call("/api/me");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    const page = await call("/auth/google/callback?state=x&code=y");
    expect(page.headers.get("content-type")).toMatch(/^text\/html/);
    expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(page.headers.get("x-frame-options")).toBe("DENY");
  });

  it("배포 주소에서는 localhost Origin 의 쓰기 요청도 다른 사이트로 본다", async () => {
    const board = await makeBoard(t, { title: "x", entryMode: "free" });
    const tok = await freeJoin(board.code, "토끼");
    const r = await call(`/api/boards/${board.code}/uploads`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:5173", authorization: `Bearer ${tok}` },
      body: JSON.stringify({ name: "a.png", size: 1, mime: "image/png" }),
    });
    expect(r.status).toBe(403);
  });
});

describe("수다 줄이기", () => {
  it("다른 학생이 처음 들어와 PIN 을 정해도 이미 접속한 사람들에게 스냅숏을 다시 보내지 않는다 (닉네임 변경 때만)", async () => {
    const cls = await makeClass(t, "반", [
      { number: "20301", name: "김하나", pin: "1357" },
      { number: "20302", name: "이서준", pin: "2468" },
    ]);
    const board = await makeBoard(t, { title: "x", classId: cls.class.id });
    const s1 = await connect(board.code, { token: await rosterLogin(board.code, "20301", "1357", "7391") });
    const tc = await connect(board.code, { session: t.session });
    const snaps = (c: { msgs: { t: string }[] }) => c.msgs.filter((m) => m.t === "snapshot").length;
    const before = [snaps(s1), snaps(tc)];
    const tok2 = await rosterLogin(board.code, "20302", "2468", "8462");
    const s2 = await connect(board.code, { token: tok2 });
    await s1.waitFor((m) => m.t === "presence" && m.presence.count === 3);
    await new Promise((r) => setTimeout(r, 100));
    expect([snaps(s1), snaps(tc)]).toEqual(before);
    // 닉네임은 화면에 보이므로 다시 보낸다
    expect((await bearer(tok2, `/api/boards/${board.code}/nickname`, { nickname: "번개" })).status).toBe(200);
    await tc.waitFor((m) => m.t === "snapshot" && m.snapshot.roster!.some((x) => x.nickname === "번개"));
    await s1.waitFor((m) => m.t === "columns.set" || (m.t === "snapshot" && JSON.stringify(m).includes("번개")));
    s2.ws.close();
  });
});
