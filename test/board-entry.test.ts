import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { resetAll } from "./helpers";
import { asTeacher, connect, connectRaw, freeJoin, makeBoard, makeClass, publicPost, rosterLogin, ROSTER, type Teacher } from "./board-helpers";
import { call } from "./helpers";
import { authenticateBoardActor, issueStudentToken } from "../src/worker/board/actor";
import { getRegistry } from "../src/worker/stubs";
import type { BoardDetail, LoginResponse, TeacherStudent, BoardSummary, StudentMeResponse } from "../src/shared/protocol";

const bearerPost = (token: string, path: string, body: unknown) => publicPost(path, body, { authorization: `Bearer ${token}` });

let t: Teacher;
beforeEach(async () => {
  await resetAll();
  t = await asTeacher();
});

async function rosterBoard() {
  const { class: cls, students } = await makeClass(t, "3학년 1반", ROSTER);
  const board = await makeBoard(t, { title: "과학 관찰", classId: cls.id, entryMode: "roster" });
  return { cls, students, board };
}

describe("교사 관리 REST", () => {
  it("로그인 없이는 401, 다른 사이트 Origin 쓰기는 403", async () => {
    expect((await call("/api/teacher/boards")).status).toBe(401);
    const res = await t.req("POST", "/api/teacher/classes", { name: "x" }, { origin: "https://evil.example" });
    expect(res.status).toBe(403);
  });

  it("반·명단 만들기 → 보드 연결 → 목록·이름 바꾸기·보관·삭제", async () => {
    const { cls, students, board } = await rosterBoard();
    expect(cls.studentCount).toBe(3);
    expect(students.map((s) => s.number)).toEqual(["20301", "20302", "20303"]);
    expect(students[0]).toMatchObject({ name: "김하나", pinRegistered: false, initialPin: "1357", group: "1모둠" });
    expect(board.code).toMatch(/^[0-9]{4}$/);
    expect(board).toMatchObject({ title: "과학 관찰", classId: cls.id, className: "3학년 1반", archived: false });
    expect(board.settings).toMatchObject({ type: "cumulative", columnMode: "student", entryMode: "roster", anonymous: false });

    let list = await t.json<{ boards: BoardSummary[] }>("GET", "/api/teacher/boards");
    expect(list.boards.map((b) => b.id)).toEqual([board.id]);

    const renamed = await t.json<BoardDetail>("PATCH", `/api/teacher/boards/${board.id}`, { title: "과학 관찰 2", moderation: true });
    expect(renamed.title).toBe("과학 관찰 2");
    expect(renamed.settings.moderation).toBe(true);
    expect((await getRegistry(env).resolveBoardByCode(board.code))?.title).toBe("과학 관찰 2");

    // 알 수 없는 설정·잘못된 조합
    expect((await t.req("PATCH", `/api/teacher/boards/${board.id}`, { nope: 1 })).status).toBe(400);
    const bad = await t.req("PATCH", `/api/teacher/boards/${board.id}`, { entryMode: "free", columnMode: "group" });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe("invalid_settings");

    const archived = await t.json<BoardDetail>("POST", `/api/teacher/boards/${board.id}/archive`);
    expect(archived.archived).toBe(true);
    expect(archived.settings.archived).toBe(true);
    list = await t.json<{ boards: BoardSummary[] }>("GET", "/api/teacher/boards");
    expect(list.boards).toEqual([]);
    list = await t.json<{ boards: BoardSummary[] }>("GET", "/api/teacher/boards?archived=1");
    expect(list.boards.length).toBe(1);
    expect((await t.json<BoardDetail>("POST", `/api/teacher/boards/${board.id}/unarchive`)).archived).toBe(false);

    // 반은 보드가 쓰는 동안 못 지움
    expect((await t.req("DELETE", `/api/teacher/classes/${cls.id}`)).status).toBe(409);
    expect((await t.req("DELETE", `/api/teacher/boards/${board.id}`)).status).toBe(204);
    expect(await getRegistry(env).resolveBoardByCode(board.code)).toBeNull();
    expect((await t.req("DELETE", `/api/teacher/classes/${cls.id}`)).status).toBe(204);
  });

  it("명단 일괄 추가: 학번 중복·잘못된 줄은 몇 번째 줄인지 알려 주고 아무것도 넣지 않는다", async () => {
    const { class: cls } = await makeClass(t, "반", [{ number: "1", name: "가" }]);
    const res = await t.req("POST", `/api/teacher/classes/${cls.id}/students`, {
      students: [{ number: "2", name: "나" }, { number: "1", name: "다" }],
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { message: string } }).error.message).toContain("2번째 줄");
    const res2 = await t.req("POST", `/api/teacher/classes/${cls.id}/students`, { students: [{ number: "abc", name: "나" }] });
    expect(res2.status).toBe(400);
    const ok = await t.json<{ added: TeacherStudent[] }>("POST", `/api/teacher/classes/${cls.id}/students`, { students: [{ number: "2", name: "나" }] });
    expect(ok.added[0]!.initialPin).toBe("1234"); // PIN 이 없으면 모두 같은 처음 PIN
    const all = await t.json<{ students: TeacherStudent[] }>("GET", `/api/teacher/classes/${cls.id}/students`);
    expect(all.students.length).toBe(2);
  });

  it("공개 정보에는 민감한 것이 없다", async () => {
    const { board } = await rosterBoard();
    const res = await call(`/api/boards/${board.code.toLowerCase()}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ code: board.code, title: "과학 관찰", entryMode: "roster", requirePin: true, locked: false, archived: false });
    expect((await call("/api/boards/ZZZZZZ")).status).toBe(404);
  });
});

describe("명단 입장 (학번 + PIN)", () => {
  it("처음 PIN 으로 바로 들어가고(바꾸라고 강제하지 않음), 나만의 PIN 으로 바꾸면 그 PIN 으로만", async () => {
    const { board } = await rosterBoard();
    const r1 = await publicPost(`/api/boards/${board.code}/login`, { number: "20301", pin: "1357" });
    expect(r1.status).toBe(200);
    const b1 = (await r1.json()) as LoginResponse;
    expect(b1.status).toBe("ok");
    // 교사가 CSV 로 적은 처음 PIN 은 모두가 아는 번호가 아니므로 바꾸자는 안내는 없다
    expect(b1.defaultPin).toBeUndefined();
    expect((await connectRaw(board.code, { token: b1.token })).status).toBe(101);
    const r2 = await bearerPost(b1.token, `/api/boards/${board.code}/pin`, { currentPin: "1357", newPin: "9024" });
    expect(r2.status, await r2.clone().text()).toBe(200);
    // 처음 PIN 은 이제 안 됨
    expect((await publicPost(`/api/boards/${board.code}/login`, { number: "20301", pin: "1357" })).status).toBe(401);
    const b3 = (await (await publicPost(`/api/boards/${board.code}/login`, { number: "20301", pin: "9024" })).json()) as LoginResponse;
    expect(b3.status).toBe("ok");
    // 교사 화면: 바꿈, 처음 PIN 은 더 이상 없음 (서버도 PIN 을 모름)
    const list = await t.json<{ students: TeacherStudent[] }>("GET", `/api/teacher/classes/${board.classId}/students`);
    expect(list.students[0]).toMatchObject({ pinRegistered: true, initialPin: null });
    // 저장된 값은 HMAC 해시 (평문 아님)
    const row = await getRegistry(env).getTeacherStudent(list.students[0]!.id);
    expect(JSON.stringify(row)).not.toContain("9024");
  });

  it("5번 틀리면 그 학번은 5분 잠금 (맞는 PIN 도 거부), 교사가 풀 수 있다", async () => {
    const { board, students } = await rosterBoard();
    await rosterLogin(board.code, "20302", "2468", "7391");
    for (let i = 0; i < 4; i++) {
      const r = await publicPost(`/api/boards/${board.code}/login`, { number: "20302", pin: "0000" });
      expect(r.status).toBe(401);
    }
    const fifth = await publicPost(`/api/boards/${board.code}/login`, { number: "20302", pin: "0000" });
    expect(fifth.status).toBe(429);
    const body = (await fifth.json()) as { error: { code: string; retryAfterMs: number } };
    expect(body.error.code).toBe("student_locked");
    expect(body.error.retryAfterMs).toBeGreaterThan(4 * 60_000);
    expect(fifth.headers.get("retry-after")).toBe("300");
    const right = await publicPost(`/api/boards/${board.code}/login`, { number: "20302", pin: "7391" });
    expect(right.status).toBe(429);
    // 다른 학번은 영향 없음
    expect((await publicPost(`/api/boards/${board.code}/login`, { number: "20301", pin: "1357" })).status).toBe(200);
    const s = students.find((x) => x.number === "20302")!;
    const listed = await t.json<{ students: TeacherStudent[] }>("GET", `/api/teacher/classes/${board.classId}/students`);
    expect(listed.students.find((x) => x.id === s.id)!.lockedUntil).toBeGreaterThan(Date.now());
    await t.json("POST", `/api/teacher/students/${s.id}/unlock`);
    expect((await publicPost(`/api/boards/${board.code}/login`, { number: "20302", pin: "7391" })).status).toBe(200);
  });

  it("IP 당 분당 실패 제한 (없는 학번 시도도 센다)", async () => {
    const { board } = await rosterBoard();
    const ip = { "cf-connecting-ip": "203.0.113.9" };
    for (let i = 0; i < 30; i++) {
      const r = await publicPost(`/api/boards/${board.code}/login`, { number: String(90000 + i), pin: "1234" }, ip);
      expect(r.status).toBe(401);
    }
    const blocked = await publicPost(`/api/boards/${board.code}/login`, { number: "20301", pin: "1357" }, ip);
    expect(blocked.status).toBe(429);
    expect(((await blocked.json()) as { error: { code: string } }).error.code).toBe("too_many_attempts");
    // 다른 IP 는 괜찮음
    expect((await publicPost(`/api/boards/${board.code}/login`, { number: "20301", pin: "1357" }, { "cf-connecting-ip": "203.0.113.10" })).status).toBe(200);
  });

  it("PIN 초기화: 처음 번호 1234 로, 기존 토큰 무효, 접속 중이면 끊김", async () => {
    const { board, students } = await rosterBoard();
    const token = await rosterLogin(board.code, "20301", "1357", "5813");
    const ws = await connect(board.code, { token });
    const s = students[0]!;
    const reset = await t.json<{ student: TeacherStudent }>("POST", `/api/teacher/students/${s.id}/reset-pin`);
    expect(reset.student.pinRegistered).toBe(false);
    expect(reset.student.initialPin).toBe("1234");
    expect((await ws.waitClose()).code).toBe(4001);
    expect((await connectRaw(board.code, { token })).status).toBe(401);
    expect((await publicPost(`/api/boards/${board.code}/login`, { number: "20301", pin: "5813" })).status).toBe(401);
    // CSV 로 받은 예전 처음 PIN 도 아님
    expect((await publicPost(`/api/boards/${board.code}/login`, { number: "20301", pin: "1357" })).status).toBe(401);
    const again = (await (await publicPost(`/api/boards/${board.code}/login`, { number: "20301", pin: "1234" })).json()) as LoginResponse;
    expect(again).toMatchObject({ status: "ok", defaultPin: true });
  });

  it("명단에서 빠진 학생은 토큰이 무효가 되고 연결이 끊긴다", async () => {
    const { board, students } = await rosterBoard();
    const token = await rosterLogin(board.code, "20302", "2468", "7391");
    const ws = await connect(board.code, { token });
    await t.json("DELETE", `/api/teacher/students/${students[1]!.id}`);
    expect((await ws.waitClose()).code).toBe(4001);
    expect((await connectRaw(board.code, { token })).status).toBe(401);
  });
});

describe("자유 입장·닉네임·토큰 범위", () => {
  it("닉네임 + 기기 토큰으로 입장, 같은 기기는 같은 ref", async () => {
    const board = await makeBoard(t, { title: "자유", entryMode: "free" });
    const device = "dev_" + "a".repeat(20);
    const t1 = await freeJoin(board.code, "토끼", device);
    const t2 = await freeJoin(board.code, "거북", device);
    const me1 = (await (await call(`/api/boards/${board.code}/me`, { headers: { authorization: `Bearer ${t1}` } })).json()) as StudentMeResponse;
    const me2 = (await (await call(`/api/boards/${board.code}/me`, { headers: { authorization: `Bearer ${t2}` } })).json()) as StudentMeResponse;
    expect(me1.student.ref).toBe(me2.student.ref);
    expect(me1.student.ref).toMatch(/^f:/);
    // 명단 보드에 자유 입장 불가
    const { class: cls } = await makeClass(t, "반", ROSTER);
    const rb = await makeBoard(t, { title: "명단", classId: cls.id });
    expect((await publicPost(`/api/boards/${rb.code}/join`, { nickname: "x", deviceToken: device })).status).toBe(400);
    expect((await publicPost(`/api/boards/${board.code}/login`, { number: "1", pin: "1234" })).status).toBe(400);
  });

  it("닉네임 바꾸기: 자유 입장은 새 토큰, 명단은 반 전체 닉네임", async () => {
    const board = await makeBoard(t, { title: "자유", entryMode: "free" });
    const tok = await freeJoin(board.code, "토끼");
    const res = await publicPost(`/api/boards/${board.code}/nickname`, { nickname: "산토끼" }, { authorization: `Bearer ${tok}` });
    expect(res.status).toBe(200);
    const b = (await res.json()) as { token: string; student: { name: string } };
    expect(b.student.name).toBe("산토끼");
    const ws = await connect(board.code, { token: b.token });
    expect(ws.snapshot!.me.name).toBe("산토끼");

    const { board: rb, students } = await rosterBoard();
    const rt = await rosterLogin(rb.code, "20301", "1357");
    const r2 = await publicPost(`/api/boards/${rb.code}/nickname`, { nickname: "하나별" }, { authorization: `Bearer ${rt}` });
    expect(r2.status).toBe(200);
    const listed = await t.json<{ students: TeacherStudent[] }>("GET", `/api/teacher/classes/${rb.classId}/students`);
    expect(listed.students.find((s) => s.id === students[0]!.id)!.nickname).toBe("하나별");
    const ws2 = await connect(rb.code, { token: rt });
    expect(ws2.snapshot!.me).toMatchObject({ name: "하나별", realName: "김하나", number: "20301" });
  });

  it("보드 A 의 학생 토큰은 보드 B 에서 거부 (authenticateBoardActor 포함)", async () => {
    const a = await makeBoard(t, { title: "A", entryMode: "free" });
    const b = await makeBoard(t, { title: "B", entryMode: "free" });
    const tokA = await freeJoin(a.code, "토끼");
    expect((await connectRaw(a.code, { token: tokA })).status).toBe(101);
    const res = await connectRaw(b.code, { token: tokA });
    expect(res.status).toBe(401);
    const req = (code: string) => new Request(`https://x/api/boards/${code}/ws`, { headers: { authorization: `Bearer ${tokA}` } });
    expect(await authenticateBoardActor(req(a.code), env, a.code)).toMatchObject({ role: "student", boardId: a.id, code: a.code });
    expect(await authenticateBoardActor(req(b.code), env, b.code)).toBeNull();
    // 위조 토큰·다른 용도 토큰
    expect(await authenticateBoardActor(new Request("https://x/", { headers: { authorization: "Bearer abc.def" } }), env, a.code)).toBeNull();
    // 교사 쿠키
    const tr = new Request("https://x/", { headers: { cookie: `__Host-nb_session=${encodeURIComponent(t.session)}` } });
    expect(await authenticateBoardActor(tr, env, b.code)).toMatchObject({ role: "teacher", ref: "teacher", boardId: b.id });
    expect(await authenticateBoardActor(new Request("https://x/"), env, b.code)).toBeNull();
  });

  it("입장 방식이 바뀌면 예전 토큰은 무효, 보관된 보드는 학생 입장 불가", async () => {
    const board = await makeBoard(t, { title: "자유", entryMode: "free" });
    const tok = await freeJoin(board.code, "토끼");
    const ws = await connect(board.code, { token: tok });
    await t.json("PATCH", `/api/teacher/boards/${board.id}`, { entryMode: "roster" });
    expect((await ws.waitClose()).code).toBe(4001);
    expect((await connectRaw(board.code, { token: tok })).status).toBe(401);
    await t.json("PATCH", `/api/teacher/boards/${board.id}`, { entryMode: "free" });
    const tok2 = await freeJoin(board.code, "토끼");
    const ws2 = await connect(board.code, { token: tok2 });
    await t.json("POST", `/api/teacher/boards/${board.id}/archive`);
    expect((await ws2.waitClose()).code).toBe(4003);
    expect((await connectRaw(board.code, { token: tok2 })).status).toBe(403);
    expect((await publicPost(`/api/boards/${board.code}/join`, { nickname: "x", deviceToken: "d".repeat(20) })).status).toBe(403);
    // 교사는 보관된 보드에도 들어간다
    expect((await connectRaw(board.code, { session: t.session })).status).toBe(101);
  });

  it("교사 쿠키 웹소켓은 다른 사이트 Origin 이면 거부, 토큰 없는 학생은 401", async () => {
    const board = await makeBoard(t, { title: "자유", entryMode: "free" });
    expect((await connectRaw(board.code, { session: t.session, origin: "https://evil.example" })).status).toBe(403);
    expect((await connectRaw(board.code, {})).status).toBe(401);
    // 서명은 맞지만 다른 보드 id 를 담은 토큰
    const forged = await issueStudentToken(env, { b: "bOTHER", r: "f:x", k: "free", n: "x" });
    expect((await connectRaw(board.code, { token: forged })).status).toBe(401);
  });
});
