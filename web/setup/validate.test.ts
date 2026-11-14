import { describe, expect, it } from "vitest";
import { checkClientId, checkEmail, checkInstanceUrl, cleanPasted, derivedFromOrigin, looksLikeClientSecret } from "./validate";

// 가짜 값. 통째로 적으면 GitHub 비밀키 검사에 걸려 나눠 적는다.
const FAKE_SECRET = "GOC" + "SPX-" + "abcdefghijklmnopqrstuvwxyz12";

describe("checkInstanceUrl", () => {
  it("정상 주소", () => {
    expect(checkInstanceUrl("https://nanumboard.hong.workers.dev")).toEqual({ ok: true, value: "https://nanumboard.hong.workers.dev" });
  });
  it("끝의 / 와 뒷부분, 공백, 따옴표를 정리한다", () => {
    const r = checkInstanceUrl('  "https://nanumboard.hong.workers.dev/setup?x=1"  ');
    expect(r.ok && r.value).toBe("https://nanumboard.hong.workers.dev");
    expect(r.ok && r.note).toContain("떼어 냈어요");
    expect(checkInstanceUrl("https://nanumboard.hong.workers.dev/")).toEqual({ ok: true, value: "https://nanumboard.hong.workers.dev" });
  });
  it("https:// 가 없으면 붙이고, http 는 https 로", () => {
    expect(checkInstanceUrl("nanumboard.hong.workers.dev")).toMatchObject({ ok: true, value: "https://nanumboard.hong.workers.dev" });
    expect(checkInstanceUrl("http://nanumboard.hong.workers.dev")).toMatchObject({ ok: true, value: "https://nanumboard.hong.workers.dev" });
  });
  it("대문자 호스트는 소문자로", () => {
    expect(checkInstanceUrl("https://NanumBoard.Hong.workers.dev")).toMatchObject({ ok: true, value: "https://nanumboard.hong.workers.dev" });
  });
  it("관리 화면·다른 사이트 주소는 거절", () => {
    expect(checkInstanceUrl("https://dash.cloudflare.com/abc/workers")).toMatchObject({ ok: false });
    expect(checkInstanceUrl("https://github.com/me/nanumboard")).toMatchObject({ ok: false });
    expect(checkInstanceUrl("")).toMatchObject({ ok: false });
    expect(checkInstanceUrl("nanum board.workers.dev")).toMatchObject({ ok: false });
  });
  it("점이 모자라면 주의 문구", () => {
    const r = checkInstanceUrl("https://hong.workers.dev");
    expect(r.ok && r.note).toBeTruthy();
  });
  it("로컬 개발 주소는 http 유지", () => {
    expect(checkInstanceUrl("http://localhost:8787/")).toEqual({ ok: true, value: "http://localhost:8787" });
  });
});

describe("checkClientId", () => {
  const ID = "123456789012-abcdefghijklmnopqrstuvwxyz012345.apps.googleusercontent.com";
  it("정상", () => expect(checkClientId(` ${ID}\n`)).toEqual({ ok: true, value: ID }));
  it("보안 비밀번호를 넣으면 경고", () => {
    const r = checkClientId(FAKE_SECRET);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain("보안 비밀번호");
    expect(looksLikeClientSecret(FAKE_SECRET)).toBe(true);
    expect(looksLikeClientSecret(ID)).toBe(false);
  });
  it("뒷부분이 잘림", () => expect(checkClientId("123456789012-abcdef")).toMatchObject({ ok: false, error: expect.stringContaining("잘렸") }));
  it("주소를 넣음", () => expect(checkClientId("https://nanumboard.hong.workers.dev")).toMatchObject({ ok: false }));
  it("엉뚱한 값", () => expect(checkClientId("hello")).toMatchObject({ ok: false }));
});

describe("기타", () => {
  it("cleanPasted 는 보이지 않는 글자를 지운다", () => expect(cleanPasted("​abc ")).toBe("abc"));
  it("checkEmail", () => {
    expect(checkEmail(" Teacher@Gmail.com ")).toEqual({ ok: true, value: "teacher@gmail.com" });
    expect(checkEmail("teacher")).toMatchObject({ ok: false });
  });
  it("derivedFromOrigin 은 정확한 리디렉션 URI 를 만든다", () => {
    const d = derivedFromOrigin("https://nanumboard.hong.workers.dev");
    expect(d.redirectUri).toBe("https://nanumboard.hong.workers.dev/auth/google/callback");
    expect(d.jsOrigin).toBe("https://nanumboard.hong.workers.dev");
    expect(d.workerName).toBe("nanumboard");
  });
});
