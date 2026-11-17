/** 입장코드: 새 보드는 숫자 4자리, 예전 영숫자 6자 보드도 그대로, 없는 코드 짐작 막기 */
import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { call, resetAll } from "./helpers";
import { asTeacher, boardStub, connect, freeJoin, makeBoard, makeClass, publicPost, rosterLogin, ROSTER, type Teacher } from "./board-helpers";
import { getRegistry } from "../src/worker/stubs";
import { formatBoardCode, isValidBoardCode, normalizeBoardCode, type BoardDetail, type StudentMeResponse } from "../src/shared/protocol";
import { isGuessableCode, pickBoardCode, randomNumericCode } from "../src/worker/registry/boards";
import { CODE_MISS_LIMIT } from "../src/worker/registry/roster";

const NOT_FOUND = { error: { code: "not_found", message: "입장코드를 다시 확인해 주세요." } };

/** 예전 모양 코드 보드 흉내: 방금 만든 보드의 코드를 Registry 원본·Board 사본 모두 바꾼다 */
async function giveLegacyCode(board: BoardDetail, code: string): Promise<void> {
  await runInDurableObject(getRegistry(env), (_i, state) => {
    state.storage.sql.exec("UPDATE boards SET code = ? WHERE id = ?", code, board.id);
  });
  const stub = boardStub(board.id);
  const detail = await stub.getTeacherDetail();
  expect((await stub.init({ boardId: board.id, code, settings: detail!.settings })).ok).toBe(true);
}

describe("입장코드 모양 (순수 함수)", () => {
  it("숫자 4~6자리와 예전 영숫자 6자를 받고, 앞자리 0 을 지킨다", () => {
    for (const c of ["4821", "0482", "00731", "048213", "K7QX2M", "ABC234", "234567"]) expect(isValidBoardCode(c), c).toBe(true);
    for (const c of ["", "482", "1234567", "48 21", "K7QX2", "K7QX0M", "K7QX1M", "ABCD", "48A1", "４８２１"]) expect(isValidBoardCode(c), c).toBe(false);
    expect(normalizeBoardCode(" 0482 ")).toBe("0482");
    expect(normalizeBoardCode("４８２１")).toBe("4821"); // 전각 숫자
    expect(normalizeBoardCode("k7q x2m")).toBe("K7QX2M");
    expect(normalizeBoardCode("K7Q-X2M")).toBe("K7QX2M");
    expect(formatBoardCode("0482")).toBe("0482");
    expect(formatBoardCode("K7QX2M")).toBe("K7Q X2M");
  });

  it("쉽게 짐작되는 코드는 막는다", () => {
    for (const c of ["0000", "1111", "9999", "1234", "4321", "0123", "7890", "8901", "3210", "1212", "9090", "12345", "54321", "77777"]) {
      expect(isGuessableCode(c), c).toBe(true);
    }
    for (const c of ["4821", "0482", "1357", "2580", "1122", "1235", "48213"]) expect(isGuessableCode(c), c).toBe(false);
  });

  it("숫자 n자리 무작위 (앞자리 0 도 나온다)", () => {
    const seen = new Set<string>();
    let leadingZero = 0;
    for (let i = 0; i < 3000; i++) {
      const c = randomNumericCode(4);
      expect(c).toMatch(/^[0-9]{4}$/);
      if (c[0] === "0") leadingZero++;
      seen.add(c);
    }
    expect(leadingZero).toBeGreaterThan(150); // 기대값 300
    expect(seen.size).toBeGreaterThan(2000);
    expect(randomNumericCode(6)).toMatch(/^[0-9]{6}$/);
  });

  it("4자리가 붐비면 5자리, 그다음 6자리로 넘어가고 다 차면 null", () => {
    for (let i = 0; i < 50; i++) {
      const c = pickBoardCode(() => false)!;
      expect(c).toMatch(/^[0-9]{4}$/);
      expect(isGuessableCode(c)).toBe(false);
    }
    expect(pickBoardCode((c) => c.length === 4)).toMatch(/^[0-9]{5}$/);
    expect(pickBoardCode((c) => c.length <= 5)).toMatch(/^[0-9]{6}$/);
    expect(pickBoardCode(() => true)).toBeNull();
    // 4자리가 거의 다 찼을 때(95%)도 실패하지 않는다
    for (let i = 0; i < 20; i++) {
      const c = pickBoardCode((x) => x.length === 4 && Number(x) % 20 !== 0)!;
      expect(c.length === 5 || Number(c) % 20 === 0, c).toBe(true);
    }
  });
});

describe("새 보드 입장코드", () => {
  let t: Teacher;
  beforeEach(async () => {
    await resetAll();
    t = await asTeacher();
  });

  it("숫자 4자리, 보드마다 다르고, 쉬운 코드는 없다", async () => {
    const codes = new Set<string>();
    for (let i = 0; i < 25; i++) {
      const b = await makeBoard(t, { title: `보드 ${i}`, entryMode: "free" });
      expect(b.code).toMatch(/^[0-9]{4}$/);
      expect(isGuessableCode(b.code)).toBe(false);
      codes.add(b.code);
    }
    expect(codes.size).toBe(25);
  });

  it("앞자리가 0 인 코드도 주소·공개 정보·입장에서 그대로", async () => {
    const b = await makeBoard(t, { title: "영으로 시작", entryMode: "free" });
    await giveLegacyCode(b, "0482"); // 같은 함수로 숫자 코드도 정할 수 있다
    const res = await call("/api/boards/0482");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { code: string }).code).toBe("0482");
    expect((await call("/api/boards/482")).status).toBe(404);
    const token = await freeJoin("0482", "하늘");
    const c = await connect("0482", { token });
    c.close();
  });
});

describe("예전 영숫자 6자 코드 보드", () => {
  let t: Teacher;
  beforeEach(async () => {
    await resetAll();
    t = await asTeacher();
  });

  it("공개 정보·명단 입장·웹소켓·내 정보가 그대로 된다 (소문자·띄어쓰기도)", async () => {
    const { class: cls } = await makeClass(t, "3학년 1반", ROSTER);
    const b = await makeBoard(t, { title: "예전 보드", classId: cls.id, entryMode: "roster" });
    await giveLegacyCode(b, "K7QX2M");
    expect((await getRegistry(env).resolveBoardByCode("K7QX2M"))?.id).toBe(b.id);
    for (const path of ["/api/boards/K7QX2M", "/api/boards/k7qx2m", "/api/boards/K7Q%20X2M"]) {
      const res = await call(path);
      expect(res.status, path).toBe(200);
      expect(await res.json()).toMatchObject({ code: "K7QX2M", title: "예전 보드" });
    }
    const token = await rosterLogin("K7QX2M", "20301", "1357");
    const me = await call("/api/boards/k7qx2m/me", { headers: { authorization: "Bearer " + token } });
    expect(me.status).toBe(200);
    expect(((await me.json()) as StudentMeResponse).student.name).toBe("김하나");
    const c = await connect("K7QX2M", { token });
    c.close();
    // 교사 목록에도 예전 코드 그대로
    const detail = await t.json<BoardDetail>("GET", `/api/teacher/boards/${b.id}`);
    expect(detail.code).toBe("K7QX2M");
    // 새 보드는 숫자 4자리, 예전 보드와 함께 있어도 된다
    expect((await makeBoard(t, { title: "새 보드", entryMode: "free" })).code).toMatch(/^[0-9]{4}$/);
  });

  it("자유 입장도 된다", async () => {
    const b = await makeBoard(t, { title: "예전 자유", entryMode: "free" });
    await giveLegacyCode(b, "ABC234");
    const token = await freeJoin("abc234", "바람");
    const c = await connect("ABC234", { token });
    c.close();
  });
});

describe("없는 코드 짐작 막기 (IP 당)", () => {
  let t: Teacher;
  beforeEach(async () => {
    await resetAll();
    t = await asTeacher();
  });

  /** 4자리 숫자 중 지금 없는 코드 n개 */
  const missing = (taken: string, n: number) => {
    const out: string[] = [];
    for (let i = 1000; out.length < n; i++) if (String(i) !== taken) out.push(String(i));
    return out;
  };

  it("없는 코드의 답은 '다시 확인해 주세요' 404 뿐 (조회·명단 로그인·자유 입장, 잘못된 모양도 같음)", async () => {
    const ip = { "cf-connecting-ip": "198.51.100.20" };
    const b = await makeBoard(t, { title: "x", entryMode: "free" });
    const [nope] = missing(b.code, 1);
    for (const res of [
      await call(`/api/boards/${nope}`, { headers: ip }),
      await call("/api/boards/ZZ", { headers: ip }),
      await publicPost(`/api/boards/${nope}/login`, { number: "20301", pin: "1357" }, ip),
      await publicPost(`/api/boards/${nope}/join`, { nickname: "가", deviceToken: "d".repeat(20) }, ip),
    ]) {
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual(NOT_FOUND);
    }
  });

  it(`없는 코드를 1분에 ${CODE_MISS_LIMIT}번 틀리면 429 (한국어 안내, 그동안은 있는 코드도 알려 주지 않음), 다른 IP 는 괜찮고 1분 지나면 풀림`, async () => {
    const b = await makeBoard(t, { title: "x", entryMode: "free" });
    const ip = { "cf-connecting-ip": "198.51.100.21" };
    const tries = missing(b.code, CODE_MISS_LIMIT);
    // 조회·로그인·입장을 섞어도 함께 센다
    for (const [i, code] of tries.entries()) {
      const res = i % 3 === 0 ? await call(`/api/boards/${code}`, { headers: ip })
        : i % 3 === 1 ? await publicPost(`/api/boards/${code}/login`, { number: "1", pin: "1111" }, ip)
        : await publicPost(`/api/boards/${code}/join`, { nickname: "가", deviceToken: "d".repeat(20) }, ip);
      expect(res.status, `${i}번째`).toBe(404);
    }
    const blocked = await call(`/api/boards/${missing(b.code, CODE_MISS_LIMIT + 1).pop()}`, { headers: ip });
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
    const body = (await blocked.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("too_many_attempts");
    expect(body.error.message).toMatch(/입장코드를 너무 많이 틀렸어요/);
    // 막힌 동안은 있는 코드도 429 (있는지 없는지 알아낼 수 없게)
    expect((await call(`/api/boards/${b.code}`, { headers: ip })).status).toBe(429);
    expect((await publicPost(`/api/boards/${b.code}/join`, { nickname: "가", deviceToken: "d".repeat(20) }, ip)).status).toBe(429);
    // 다른 IP 는 괜찮음
    expect((await call(`/api/boards/${b.code}`, { headers: { "cf-connecting-ip": "198.51.100.22" } })).status).toBe(200);
    // 1분이 지나면 풀린다
    await runInDurableObject(getRegistry(env), (_i, state) => {
      state.storage.sql.exec("UPDATE login_throttle SET window_start = window_start - 61000 WHERE key = ?", "code:198.51.100.21");
    });
    expect((await call(`/api/boards/${b.code}`, { headers: ip })).status).toBe(200);
  });

  it("한 반이 한 IP(학교 NAT)로 있는 코드를 아무리 많이 열어도 막히지 않는다 (틀린 것만 센다)", async () => {
    const { class: cls } = await makeClass(t, "3학년 1반", ROSTER);
    const roster = await makeBoard(t, { title: "명단", classId: cls.id, entryMode: "roster" });
    const free = await makeBoard(t, { title: "자유", entryMode: "free" });
    const nat = { "cf-connecting-ip": "203.0.113.50" };
    for (let i = 0; i < 120; i++) expect((await call(`/api/boards/${i % 2 ? roster.code : free.code}`, { headers: nat })).status).toBe(200);
    for (let i = 0; i < 40; i++) {
      const res = await publicPost(`/api/boards/${free.code}/join`, { nickname: `학생${i}`, deviceToken: `nat-device-${i}-`.padEnd(24, "x") }, nat);
      expect(res.status).toBe(200);
    }
    expect((await publicPost(`/api/boards/${roster.code}/login`, { number: "20301", pin: "1357" }, nat)).status).toBe(200);
    // 몇 명이 코드를 잘못 쳐도 (한도 아래) 다른 학생은 그대로 들어간다
    const taken = new Set([roster.code, free.code]);
    let typos = 0;
    for (let i = 1000; typos < CODE_MISS_LIMIT - 1; i++) {
      if (taken.has(String(i))) continue;
      expect((await call(`/api/boards/${i}`, { headers: nat })).status).toBe(404);
      typos++;
    }
    expect((await call(`/api/boards/${free.code}`, { headers: nat })).status).toBe(200);
    expect((await publicPost(`/api/boards/${free.code}/join`, { nickname: "늦게 온 학생", deviceToken: "nat-device-late".padEnd(24, "x") }, nat)).status).toBe(200);
  });

  it("다른 보드 학생 토큰으로 없는 코드를 물어도 '없음'을 알려 주지 않는다", async () => {
    const b = await makeBoard(t, { title: "x", entryMode: "free" });
    const token = await freeJoin(b.code, "가");
    const [nope] = missing(b.code, 1);
    const other = await makeBoard(t, { title: "y", entryMode: "free" });
    const auth = { authorization: "Bearer " + token };
    const resNope = await call(`/api/boards/${nope}/me`, { headers: auth });
    const resOther = await call(`/api/boards/${other.code}/me`, { headers: auth });
    expect(resNope.status).toBe(401);
    expect(resOther.status).toBe(401);
    expect(await resNope.json()).toEqual(await resOther.json());
  });
});
