import { describe, expect, it } from "vitest";
import jsQR from "jsqr";
import { csvCell, detectDelimiter, paginate, parseDelimited, parseRoster, rosterCsv, safeFileName, sampleRosterCsv, toCsv } from "./roster";
import { backupText, matchesBoard, parseTopics, relativeTime, sortBoards, spacedCode, studentUrl } from "./format";
import { qrMatrix, qrPath } from "./qr";
import type { TeacherStudent } from "../../src/shared/protocol";

describe("parseDelimited", () => {
  it("따옴표 안 쉼표·줄바꿈·\"\" 를 처리한다", () => {
    expect(parseDelimited('a,"b,c","d ""e""",f\r\n"x\ny",z', ",")).toEqual([
      ["a", "b,c", 'd "e"', "f"],
      ["x\ny", "z"],
    ]);
  });
  it("BOM 과 CR 만 있는 줄바꿈도 처리한다", () => {
    expect(parseDelimited("﻿1,2\r3,4", ",")).toEqual([
      ["1", "2"],
      ["3", "4"],
    ]);
  });
  it("구분자를 고른다", () => {
    expect(detectDelimiter("학번\t이름\n1\t2")).toBe("\t");
    expect(detectDelimiter("학번;이름\n1;2")).toBe(";");
    expect(detectDelimiter("학번,이름")).toBe(",");
    expect(detectDelimiter('"a\tb",c')).toBe(",");
    expect(detectDelimiter("\n\n1\t김")).toBe("\t");
  });
});

describe("parseRoster", () => {
  it("제목 줄이 있는 CSV(BOM, CRLF)를 열 이름으로 읽는다", () => {
    const r = parseRoster("﻿이름,학번,모둠,PIN\r\n김하나,20301,1모둠,1234\r\n이두리,20302,2모둠,\r\n");
    expect(r.hasHeader).toBe(true);
    expect(r.problems).toEqual([]);
    expect(r.errorCount).toBe(0);
    expect(r.valid).toEqual([
      { number: "20301", name: "김하나", pin: "1234", group: "1모둠" },
      { number: "20302", name: "이두리", group: "2모둠" },
    ]);
    expect(r.rows[0]!.line).toBe(2);
  });

  it("스프레드시트에서 붙여 넣은 탭 구분 3칸 (학번, 이름, 모둠)", () => {
    const r = parseRoster("20301\t김하나\t1모둠\n20302\t이두리\t2모둠\n\n");
    expect(r.hasHeader).toBe(false);
    expect(r.delimiter).toBe("\t");
    expect(r.columns).toEqual(["number", "name", "group"]);
    expect(r.valid.map((v) => v.group)).toEqual(["1모둠", "2모둠"]);
  });

  it("3칸이 모두 숫자 4자리면 PIN 으로 본다", () => {
    const r = parseRoster("1,가,1234\n2,나,0042");
    expect(r.columns[2]).toBe("pin");
    expect(r.valid.map((v) => v.pin)).toEqual(["1234", "0042"]);
  });

  it("4칸 이상은 PROTOCOL 순서 (학번,이름,PIN,모둠,닉네임)", () => {
    const r = parseRoster("1,가,,A모둠,별빛");
    expect(r.valid).toEqual([{ number: "1", name: "가", group: "A모둠", nickname: "별빛" }]);
  });

  it("엑셀이 지운 PIN 앞자리 0 을 채우고 알려 준다", () => {
    const r = parseRoster("학번,이름,PIN\n1,가,42");
    expect(r.valid[0]!.pin).toBe("0042");
    expect(r.rows[0]!.notes[0]).toContain("0042");
  });

  it("줄마다 오류: 빈 학번, 숫자 아닌 학번, 빈 이름, 잘못된 PIN, 긴 값", () => {
    const r = parseRoster(["학번,이름,PIN,모둠", ",가,,", "2a,나,,", "3,,,", "4,라,12345,", `5,마,,${"모".repeat(41)}`].join("\n"));
    expect(r.errorCount).toBe(5);
    expect(r.rows.map((x) => x.errors.length > 0)).toEqual([true, true, true, true, true]);
    expect(r.rows[0]!.errors[0]).toContain("학번");
    expect(r.rows[2]!.errors[0]).toContain("이름");
    expect(r.rows[3]!.errors[0]).toContain("PIN");
    expect(r.rows[4]!.errors[0]).toContain("모둠");
    expect(r.valid).toEqual([]);
  });

  it("파일 안 중복 학번과 반에 이미 있는 학번을 잡는다", () => {
    const r = parseRoster("1,가\n2,나\n1,다\n9,라", { existingNumbers: ["9"] });
    expect(r.rows[2]!.errors[0]).toContain("1번째 줄과 겹쳐요");
    expect(r.rows[3]!.errors[0]).toContain("이미 이 반에 있어요");
    expect(r.valid.map((v) => v.number)).toEqual(["1", "2"]);
    expect(r.errorCount).toBe(2);
  });

  it("전각 숫자·작은따옴표·20301.0 같은 학번을 정리한다", () => {
    const r = parseRoster("２０３０１,가\n'20302,나\n20303.0,다");
    expect(r.valid.map((v) => v.number)).toEqual(["20301", "20302", "20303"]);
  });

  it("제목 줄에 학번 열이 없으면 표 전체 문제", () => {
    const r = parseRoster("이름,모둠\n가,1");
    expect(r.problems[0]).toContain("학번");
    expect(r.valid).toEqual([]);
  });

  it("영문 제목, 따옴표 안 쉼표 이름", () => {
    const r = parseRoster('Number,Name,Group\n7,"Kim, Hana",B');
    expect(r.valid).toEqual([{ number: "7", name: "Kim, Hana", group: "B" }]);
  });

  it("빈 입력", () => {
    const r = parseRoster("  \n\n");
    expect(r.rows).toEqual([]);
    expect(r.problems.length).toBe(1);
  });

  it("반 인원 상한", () => {
    const text = Array.from({ length: 501 }, (_, i) => `${i + 1},학생${i + 1}`).join("\n");
    expect(parseRoster(text).problems.join()).toContain("500명");
  });

  it("예시 CSV 는 오류 없이 다시 읽힌다", () => {
    const r = parseRoster(sampleRosterCsv());
    expect(r.hasHeader).toBe(true);
    expect(r.errorCount).toBe(0);
    expect(r.valid.length).toBe(4);
    expect(r.valid[3]!.nickname).toBe("별빛");
  });
});

describe("CSV 만들기", () => {
  it("수식 주입을 막고 따옴표를 이스케이프한다", () => {
    expect(csvCell("=SUM(A1)")).toBe(`"'=SUM(A1)"`);
    expect(csvCell('a"b')).toBe(`"a""b"`);
    expect(toCsv([["a", 1]])).toBe('﻿"a","1"\r\n');
  });
  it("명단 CSV: 학번순, 등록한 학생은 PIN 빈칸", () => {
    const s = (number: string, initialPin: string | null): TeacherStudent => ({
      id: number, classId: "c", ref: "s:" + number, number, name: "이름" + number, nickname: "", group: "", pinRegistered: initialPin === null, initialPin, lockedUntil: null,
    });
    const csv = rosterCsv([s("10", null), s("2", "0420")]);
    const rows = parseDelimited(csv, ",");
    expect(rows[1]).toEqual(["2", "이름2", "", "", "0420", "처음 입장 전"]);
    expect(rows[2]).toEqual(["10", "이름10", "", "", "", "학생이 직접 정함"]);
  });
  it("파일 이름 정리", () => {
    expect(safeFileName('3/2반: "과학"')).toBe("3_2반_ _과학_");
    expect(safeFileName("...")).toBe("명단");
  });
  it("쪽지 나누기", () => {
    expect(paginate([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(paginate([], 12)).toEqual([]);
  });
});

describe("format", () => {
  const now = 1_700_000_000_000;
  it("상대 시간", () => {
    expect(relativeTime(null, now)).toBe("아직 없음");
    expect(relativeTime(now - 10_000, now)).toBe("방금");
    expect(relativeTime(now - 5 * 60_000, now)).toBe("5분 전");
    expect(relativeTime(now - 3 * 3600_000, now)).toBe("3시간 전");
    expect(relativeTime(now - 26 * 3600_000, now)).toBe("어제");
    expect(relativeTime(now - 4 * 86400_000, now)).toBe("4일 전");
  });
  it("보드 검색·정렬", () => {
    expect(matchesBoard({ title: "우리 동네 생물", code: "K7QX2M", className: "3학년 2반" }, "동네생물")).toBe(true);
    expect(matchesBoard({ title: "a", code: "K7QX2M", className: null }, "k7q")).toBe(true);
    expect(matchesBoard({ title: "a", code: "K7QX2M", className: "3학년 2반" }, "2반")).toBe(true);
    expect(matchesBoard({ title: "a", code: "K7QX2M", className: null }, "zz")).toBe(false);
    expect(matchesBoard({ title: "a", code: "0482", className: null }, "048")).toBe(true);
    const sorted = sortBoards([
      { id: "old", lastPostAt: null, updatedAt: 1, createdAt: 1 },
      { id: "new", lastPostAt: 50, updatedAt: 2, createdAt: 2 },
    ]);
    expect(sorted.map((b) => b.id)).toEqual(["new", "old"]);
  });
  it("주제 이름 정리", () => {
    expect(parseTopics("좋았던 점\n아쉬운 점, 궁금한 점\n\n좋았던 점")).toEqual(["좋았던 점", "아쉬운 점", "궁금한 점"]);
    expect(parseTopics("a,b,c", 2)).toEqual(["a", "b"]);
  });
  it("백업 문장·주소·코드", () => {
    expect(backupText({ state: "unavailable", lastSuccessAt: null, lastAttemptAt: null, failures: 1, lastError: null, nextAttemptAt: null }).tone).toBe("danger");
    expect(backupText({ state: "ok", lastSuccessAt: now - 60_000, lastAttemptAt: now, failures: 0, lastError: null, nextAttemptAt: null }, now).text).toContain("1분 전");
    expect(studentUrl("https://a.example/", "K7QX2M")).toBe("https://a.example/b/K7QX2M");
    expect(spacedCode("K7QX2M")).toBe("K7Q X2M");
    expect(spacedCode("4821")).toBe("4821");
    expect(spacedCode("0482")).toBe("0482");
  });
});

describe("QR", () => {
  it("만든 QR 행렬을 디코더가 같은 주소로 읽는다", () => {
    const text = "https://nanumboard.example.workers.dev/b/K7QX2M";
    const m = qrMatrix(text);
    const scale = 6;
    const size = m.length * scale;
    const rgba = new Uint8ClampedArray(size * size * 4);
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        const v = m[Math.floor(y / scale)]![Math.floor(x / scale)] ? 0 : 255;
        const i = (y * size + x) * 4;
        rgba[i] = rgba[i + 1] = rgba[i + 2] = v;
        rgba[i + 3] = 255;
      }
    expect(jsQR(rgba, size, size)?.data).toBe(text);
  });
  it("SVG 경로", () => {
    const p = qrPath("hi");
    expect(p.size).toBeGreaterThan(20);
    expect(p.d.startsWith("M")).toBe(true);
  });
});
