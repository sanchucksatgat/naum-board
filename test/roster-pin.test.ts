/**
 * 명단 입장의 PIN 규칙 (처음 PIN 1234, 학생이 직접 바꾸기, PIN 없이 학번만 입장, 설정 바꾸기, 마이그레이션).
 * docs/PROTOCOL.md §1.1·§8.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { call, resetAll } from "./helpers";
import { asTeacher, changePin, connect, connectRaw, makeBoard, makeClass, publicPost, rosterLogin, sleep, type Teacher } from "./board-helpers";
import { issueStudentToken } from "../src/worker/board/actor";
import { getRegistry } from "../src/worker/stubs";
import { applyMigrations, REGISTRY_MIGRATIONS } from "../src/worker/registry/migrations";
import type { BoardDetail, BoardPublicInfo, BoardSummary, LoginResponse, StudentMeResponse, TeacherStudent, TokenResponse } from "../src/shared/protocol";

let t: Teacher;
beforeEach(async () => {
  await resetAll();
  t = await asTeacher();
});

const KIDS = [
  { number: "20301", name: "김하나" },
  { number: "20302", name: "이서준" },
  { number: "20303", name: "박지우", pin: "5813" },
];

async function setup(board: Record<string, unknown> = {}) {
  const { class: cls, students } = await makeClass(t, "3학년 1반", KIDS);
  const b = await makeBoard(t, { title: "관찰", classId: cls.id, ...board });
  return { cls, students, board: b };
}

const login = (code: string, body: Record<string, unknown>, headers: Record<string, string> = {}) => publicPost(`/api/boards/${code}/login`, body, headers);

async function errorOf(res: Response): Promise<{ code: string; message: string; retryAfterMs?: number }> {
  return ((await res.json()) as { error: { code: string; message: string; retryAfterMs?: number } }).error;
}

async function listStudents(classId: string) {
  return (await t.json<{ students: TeacherStudent[] }>("GET", `/api/teacher/classes/${classId}/students`)).students;
}

describe("처음 PIN 1234", () => {
  it("CSV 에 PIN 이 없으면 1234, 적었으면 그 번호. 처음 PIN 으로 바로 들어가고 계속 들어갈 수 있다 (강제로 바꾸지 않음)", async () => {
    const { cls, board } = await setup();
    const list = await listStudents(cls.id);
    expect(list.map((s) => [s.number, s.initialPin, s.pinRegistered])).toEqual([
      ["20301", "1234", false],
      ["20302", "1234", false],
      ["20303", "5813", false],
    ]);
    for (let i = 0; i < 2; i++) {
      const r = await login(board.code, { number: "20301", pin: "1234" });
      expect(r.status).toBe(200);
      const b = (await r.json()) as LoginResponse;
      // 모두 아는 번호로 들어왔으니 바꾸자고 권한다
      expect(b).toMatchObject({ status: "ok", defaultPin: true, student: { name: "김하나", number: "20301" } });
      const ws = await connect(board.code, { token: b.token });
      expect(ws.snapshot!.me.name).toBe("김하나");
      ws.ws.close();
    }
    // 따로 받은 처음 PIN: 1234 는 안 되고, 바꾸자는 안내도 없음
    expect((await login(board.code, { number: "20303", pin: "1234" })).status).toBe(401);
    const custom = (await (await login(board.code, { number: "20303", pin: "5813" })).json()) as LoginResponse;
    expect(custom.status).toBe("ok");
    expect(custom.defaultPin).toBeUndefined();
    expect((await getRegistry(env).listStudents(cls.id))!.every((s) => !s.pinRegistered)).toBe(true);
  });

  it("교사 PIN 초기화는 CSV 로 받은 처음 PIN 학생도 1234 로", async () => {
    const { cls, students, board } = await setup();
    const s = students.find((x) => x.number === "20303")!;
    const r = await t.json<{ student: TeacherStudent }>("POST", `/api/teacher/students/${s.id}/reset-pin`);
    expect(r.student).toMatchObject({ initialPin: "1234", pinRegistered: false, lockedUntil: null });
    expect((await login(board.code, { number: "20303", pin: "5813" })).status).toBe(401);
    expect((await login(board.code, { number: "20303", pin: "1234" })).status).toBe(200);
    expect((await listStudents(cls.id)).find((x) => x.id === s.id)!.initialPin).toBe("1234");
  });
});

describe("학생이 PIN 바꾸기 (내 정보)", () => {
  it("지금 PIN 확인, 1234·형식 틀림 거부, 바꾸면 다른 기기 입장은 모두 끝나고 새 토큰만 쓸 수 있다", async () => {
    const { cls, board } = await setup();
    const tokA = (await ((await login(board.code, { number: "20301", pin: "1234" })).json() as Promise<LoginResponse>)).token;
    // 친구가 1234 로 같은 학생 이름으로 들어와 있다
    const tokB = (await ((await login(board.code, { number: "20301", pin: "1234" })).json() as Promise<LoginResponse>)).token;
    const wsB = await connect(board.code, { token: tokB });

    // 토큰 없이·남의 보드 토큰 없이는 안 됨
    expect((await publicPost(`/api/boards/${board.code}/pin`, { currentPin: "1234", newPin: "9024" })).status).toBe(401);
    // 지금 PIN 틀림
    const wrong = await changePin(board.code, tokA, "1111", "9024");
    expect(wrong.status).toBe(401);
    expect((await errorOf(wrong)).code).toBe("invalid_credentials");
    // 새 PIN 이 1234 → 거부
    const same = await changePin(board.code, tokA, "1234", "1234");
    expect(same.status).toBe(400);
    const sameErr = await errorOf(same);
    expect(sameErr.code).toBe("invalid_pin");
    expect(sameErr.message).toContain("1234");
    // 숫자 4자리가 아님
    for (const bad of ["12a4", "123", "12345", "", {}, null]) {
      expect((await changePin(board.code, tokA, "1234", bad)).status, String(bad)).toBe(400);
    }
    const ok = await changePin(board.code, tokA, "1234", "2580");
    expect(ok.status, await ok.clone().text()).toBe(200);
    const fresh = ((await ok.json()) as TokenResponse).token;

    // 예전 토큰(이 기기·친구 기기) 모두 무효, 연결은 4001
    expect((await wsB.waitClose()).code).toBe(4001);
    expect((await connectRaw(board.code, { token: tokA })).status).toBe(401);
    expect((await connectRaw(board.code, { token: tokB })).status).toBe(401);
    expect((await connectRaw(board.code, { token: fresh })).status).toBe(101);
    // 이제 1234 로는 못 들어오고 새 PIN 으로만
    expect((await login(board.code, { number: "20301", pin: "1234" })).status).toBe(401);
    const again = (await (await login(board.code, { number: "20301", pin: "2580" })).json()) as LoginResponse;
    expect(again.status).toBe("ok");
    expect(again.defaultPin).toBeUndefined();

    // 교사 명단: "바꿈" 상태만, 바꾼 PIN 은 어디에도 없음
    const listRes = await t.req("GET", `/api/teacher/classes/${cls.id}/students`);
    const raw = await listRes.text();
    expect(raw).not.toContain("2580");
    const me = (JSON.parse(raw) as { students: TeacherStudent[] }).students.find((s) => s.number === "20301")!;
    expect(me).toMatchObject({ pinRegistered: true, initialPin: null });
    const portfolio = await (await t.req("GET", `/api/teacher/students/${me.id}/portfolio`)).text();
    expect(portfolio).not.toContain("2580");

    // 바꾼 PIN 을 다시 바꿀 때도 지금 PIN 이 필요. 쉬운 번호(1111)는 서버가 막지 않는다 (화면에서 알려만 줌)
    expect((await changePin(board.code, again.token, "1234", "1111")).status).toBe(401);
    expect((await changePin(board.code, again.token, "2580", "1111")).status).toBe(200);
  });

  it("지금 PIN 을 5번 틀리면 로그인과 똑같이 잠기고, 잠긴 동안은 바꿀 수 없다", async () => {
    const { board } = await setup();
    const tok = (await ((await login(board.code, { number: "20302", pin: "1234" })).json() as Promise<LoginResponse>)).token;
    for (let i = 0; i < 4; i++) expect((await changePin(board.code, tok, "0000", "9024")).status).toBe(401);
    const fifth = await changePin(board.code, tok, "0000", "9024");
    expect(fifth.status).toBe(429);
    expect((await errorOf(fifth)).code).toBe("student_locked");
    expect((await changePin(board.code, tok, "1234", "9024")).status).toBe(429);
    expect((await login(board.code, { number: "20302", pin: "1234" })).status).toBe(429);
  });
});

describe("잠금 (모두 1234 를 알아도 예전과 같은 보호)", () => {
  it("PIN 을 바꾼 학생: 친구가 1234 를 5번 넣으면 5분 잠금 — 예전처럼 학번당 5회. 잠금 안내는 쉬운 말, 교사가 풀 수 있다", async () => {
    const { cls, board } = await setup();
    await rosterLogin(board.code, "20301", "1234", "7391");
    for (let i = 0; i < 4; i++) expect((await login(board.code, { number: "20301", pin: "1234" })).status).toBe(401);
    const fifth = await login(board.code, { number: "20301", pin: "1234" });
    expect(fifth.status).toBe(429);
    const e = await errorOf(fifth);
    expect(e.code).toBe("student_locked");
    expect(e.retryAfterMs).toBeGreaterThan(4 * 60_000);
    expect(e.message).toContain("선생님");
    // 잠긴 동안은 맞는 PIN 도 거부
    expect((await login(board.code, { number: "20301", pin: "7391" })).status).toBe(429);
    // 다른 학생은 영향 없음
    expect((await login(board.code, { number: "20302", pin: "1234" })).status).toBe(200);
    const id = (await listStudents(cls.id)).find((s) => s.number === "20301")!.id;
    await t.json("POST", `/api/teacher/students/${id}/unlock`);
    expect((await login(board.code, { number: "20301", pin: "7391" })).status).toBe(200);
  });
});

describe("PIN 없이 학번만으로 입장", () => {
  it("설정이 공개 정보·교사 요약에 보이고, 학번만으로 들어가며 PIN 은 무시, 잠금 없음", async () => {
    const { cls, board } = await setup({ requirePin: false });
    expect(board.requirePin).toBe(false);
    expect(board.settings.requirePin).toBe(false);
    const info = (await (await call(`/api/boards/${board.code}`)).json()) as BoardPublicInfo;
    expect(info).toMatchObject({ entryMode: "roster", requirePin: false });
    const summaries = await t.json<{ boards: BoardSummary[] }>("GET", "/api/teacher/boards");
    expect(summaries.boards[0]!.requirePin).toBe(false);

    const r = await login(board.code, { number: "20302" });
    expect(r.status, await r.clone().text()).toBe(200);
    const b = (await r.json()) as LoginResponse;
    expect(b.status).toBe("ok");
    expect(b.defaultPin).toBeUndefined();
    expect(b.student).toMatchObject({ realName: "이서준", number: "20302" });
    const ws = await connect(board.code, { token: b.token });
    expect(ws.snapshot!.me).toMatchObject({ realName: "이서준", number: "20302" });
    expect(ws.snapshot!.settings.requirePin).toBe(false);
    const me = (await (await call(`/api/boards/${board.code}/me`, { headers: { authorization: `Bearer ${b.token}` } })).json()) as StudentMeResponse;
    expect(me.student.number).toBe("20302");
    // 틀린 PIN 을 같이 보내도(무시) 들어가고, 여러 번 해도 잠기지 않는다
    for (let i = 0; i < 7; i++) expect((await login(board.code, { number: "20302", pin: "0000" })).status).toBe(200);
    expect((await listStudents(cls.id)).find((s) => s.number === "20302")!.lockedUntil).toBeNull();
    // PIN 바꾸기는 이 보드에서 못 함
    const cp = await changePin(board.code, b.token, "1234", "9024");
    expect(cp.status).toBe(400);
    expect((await errorOf(cp)).code).toBe("wrong_entry_mode");
    // 개인별 열·미제출자는 그대로
    const tc = await connect(board.code, { session: t.session });
    expect(tc.snapshot!.notSubmitted!.length).toBe(3);
    expect(tc.snapshot!.columns.filter((c) => c.kind === "student").length).toBe(3);
    await ws.ok({ t: "post.save", post: { body: "학번만으로 쓴 글" } });
    await tc.waitFor((m) => m.t === "submission" && m.notSubmitted.length === 2);
  });

  it("없는 학번은 어느 학번이 있는지 알려 주지 않는 같은 오류, IP 실패 제한은 그대로", async () => {
    const { board } = await setup({ requirePin: false });
    const ip = { "cf-connecting-ip": "203.0.113.50" };
    const a = await login(board.code, { number: "99999" }, ip);
    expect(a.status).toBe(401);
    const ea = await errorOf(a);
    expect(ea).toMatchObject({ code: "invalid_credentials", message: "학번을 다시 확인해 주세요." });
    const bad = await login(board.code, { number: "abc!" }, ip);
    expect(bad.status).toBe(401);
    expect(await errorOf(bad)).toEqual(ea);
    for (let i = 0; i < 28; i++) expect((await login(board.code, { number: String(90000 + i) }, ip)).status).toBe(401);
    const blocked = await login(board.code, { number: "20301" }, ip);
    expect(blocked.status).toBe(429);
    expect((await errorOf(blocked)).code).toBe("too_many_attempts");
    expect((await login(board.code, { number: "20301" }, { "cf-connecting-ip": "203.0.113.51" })).status).toBe(200);
  });

  it("PIN 을 묻는 보드에는 PIN 없이 못 들어온다 (조작한 요청·위조한 학번만 토큰 포함)", async () => {
    const { board, students } = await setup();
    for (const body of [{ number: "20301" }, { number: "20301", pin: "" }, { number: "20301", pin: null }, { number: "20301", requirePin: false }, { number: "20301", pin: "1234x" }]) {
      const r = await login(board.code, body);
      expect(r.status, JSON.stringify(body)).toBe(401);
      expect((await errorOf(r)).code).toBe("invalid_credentials");
    }
    // 서버 키로 서명된 "PIN 없이 들어온" 토큰이라도 PIN 을 묻는 보드에서는 거부 (설정이 바뀐 뒤 남은 토큰과 같음)
    const s = students[0]!;
    const forged = await issueStudentToken(env, { b: board.id, r: s.ref, k: "roster", sid: s.id, pv: 0, np: 1 });
    expect((await connectRaw(board.code, { token: forged })).status).toBe(401);
    expect((await call(`/api/boards/${board.code}/me`, { headers: { authorization: `Bearer ${forged}` } })).status).toBe(401);
    expect((await changePin(board.code, forged, "1234", "9024")).status).toBe(401);
    // 같은 반의 PIN 없는 보드에서 받은 토큰도 이 보드에서는 무효 (보드 범위)
    const other = await makeBoard(t, { title: "학번만", classId: board.classId, requirePin: false });
    const tokOther = ((await (await login(other.code, { number: "20301" })).json()) as LoginResponse).token;
    expect((await connectRaw(other.code, { token: tokOther })).status).toBe(101);
    expect((await connectRaw(board.code, { token: tokOther })).status).toBe(401);
  });

  it("설정 바꾸기: PIN → 학번만이면 아무도 안 끊기고, 학번만 → PIN 이면 PIN 없이 들어온 학생만 끊긴다", async () => {
    const { board } = await setup();
    const tokPin = await rosterLogin(board.code, "20301", "1234", null);
    const wsPin = await connect(board.code, { token: tokPin });

    let d = await t.json<BoardDetail>("PATCH", `/api/teacher/boards/${board.id}`, { requirePin: false });
    expect(d).toMatchObject({ requirePin: false, settings: { requirePin: false } });
    expect((await getRegistry(env).resolveBoardByCode(board.code))!.requirePin).toBe(false);
    await wsPin.waitFor((m) => m.t === "settings.update" && m.settings.requirePin === false);
    const tokNo = ((await (await login(board.code, { number: "20302" })).json()) as LoginResponse).token;
    const wsNo = await connect(board.code, { token: tokNo });
    expect(wsPin.closed).toBeNull();

    d = await t.json<BoardDetail>("PATCH", `/api/teacher/boards/${board.id}`, { requirePin: true });
    expect(d.settings.requirePin).toBe(true);
    expect((await wsNo.waitClose()).code).toBe(4001);
    await sleep(50);
    expect(wsPin.closed).toBeNull();
    expect((await connectRaw(board.code, { token: tokNo })).status).toBe(401);
    expect((await connectRaw(board.code, { token: tokPin })).status).toBe(101);
    // 다시 들어오려면 학번 + PIN
    expect((await login(board.code, { number: "20302" })).status).toBe(401);
    expect((await login(board.code, { number: "20302", pin: "1234" })).status).toBe(200);
    // 잘못된 값
    expect((await t.req("PATCH", `/api/teacher/boards/${board.id}`, { requirePin: "no" })).status).toBe(400);
  });
});

describe("마이그레이션: 처음 PIN 을 1234 로", () => {
  it("아직 안 바꾼 학생의 예전 무작위 처음 PIN 은 1234 가 되고, 나만의 PIN 을 정한 학생은 그대로", async () => {
    const { cls, board } = await setup();
    await rosterLogin(board.code, "20302", "1234", "7391");
    await runInDurableObject(getRegistry(env), (_inst, state) => {
      const sql = state.storage.sql;
      // 예전 설치 상태 흉내: 무작위 처음 PIN, 마이그레이션 4 적용 전
      sql.exec("UPDATE students SET initial_pin = '8642' WHERE number = '20301'");
      sql.exec("UPDATE students SET initial_pin = '0471' WHERE number = '20303'");
      const before = sql.exec<{ pin_hash: string | null; pin_version: number }>("SELECT pin_hash, pin_version FROM students WHERE number = '20302'").one();
      expect(before.pin_hash).not.toBeNull();
      sql.exec("DELETE FROM _migrations WHERE version >= 4");
      applyMigrations(state.storage, REGISTRY_MIGRATIONS);
      const v = sql.exec<{ v: number }>("SELECT MAX(version) AS v FROM _migrations").one().v;
      expect(v).toBe(REGISTRY_MIGRATIONS.length);
      const rows = sql
        .exec<{ number: string; initial_pin: string | null; pin_hash: string | null; pin_version: number }>("SELECT number, initial_pin, pin_hash, pin_version FROM students ORDER BY number")
        .toArray();
      expect(rows.map((r) => [r.number, r.initial_pin])).toEqual([
        ["20301", "1234"],
        ["20302", null],
        ["20303", "1234"],
      ]);
      expect(rows[1]!.pin_hash).toBe(before.pin_hash);
      expect(rows[1]!.pin_version).toBe(before.pin_version);
      // 기존 보드는 PIN 을 묻는 그대로
      expect(sql.exec<{ require_pin: number }>("SELECT require_pin FROM boards").one().require_pin).toBe(1);
    });
    expect((await login(board.code, { number: "20301", pin: "1234" })).status).toBe(200);
    expect((await login(board.code, { number: "20301", pin: "8642" })).status).toBe(401);
    expect((await login(board.code, { number: "20302", pin: "7391" })).status).toBe(200);
    expect((await listStudents(cls.id)).map((s) => s.initialPin)).toEqual(["1234", null, "1234"]);
  });
});
