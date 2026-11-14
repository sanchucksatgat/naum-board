/**
 * 설치 안내에서 선생님이 붙여 넣은 값을 검사하고, 그 값으로 복사할 값을 만든다.
 * 화면(DOM)과 상관없는 순수 함수만 둔다 (web/setup/validate.test.ts 에서 시험).
 */

export type Check<T> = { ok: true; value: T; note?: string } | { ok: false; error: string };

/** 붙여 넣을 때 자주 딸려 오는 공백·따옴표·보이지 않는 글자 제거 */
export function cleanPasted(raw: string): string {
  return raw
    .replace(/[​-‍﻿ ]/g, " ")
    .trim()
    .replace(/^["'`<(\[]+|["'`>)\],.;]+$/g, "")
    .trim();
}

/**
 * 나눔보드 주소 검사. 예: https://nanumboard.hong.workers.dev
 * - https:// 를 빠뜨렸으면 붙여 준다.
 * - 끝의 / 나 /setup, /teacher 같은 뒷부분은 떼어 낸다 (note 로 알려 줌).
 */
export function checkInstanceUrl(raw: string): Check<string> {
  const s = cleanPasted(raw);
  if (!s) return { ok: false, error: "주소를 붙여 넣어 주세요." };
  if (/\s/.test(s)) return { ok: false, error: "주소 중간에 띄어쓰기가 있어요. 주소만 다시 복사해 주세요." };
  let input = s;
  if (/^http:\/\//i.test(input)) {
    const host = input.slice(7).split("/")[0] ?? "";
    if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(host)) input = "https://" + input.slice(7);
  } else if (!/^https:\/\//i.test(input)) {
    if (/^[a-z]+:\/\//i.test(input)) return { ok: false, error: "https:// 로 시작하는 주소여야 해요." };
    input = "https://" + input;
  }
  let u: URL;
  try {
    u = new URL(input);
  } catch {
    return { ok: false, error: "주소 모양이 아니에요. 예: https://nanumboard.내이름.workers.dev" };
  }
  const host = u.hostname.toLowerCase();
  const local = host === "localhost" || host === "127.0.0.1";
  if (!local) {
    if (host === "workers.dev" || host === "dash.cloudflare.com" || host.endsWith(".cloudflare.com")) {
      return { ok: false, error: "이건 Cloudflare 관리 화면 주소예요. 끝이 .workers.dev 인 나눔보드 주소를 찾아 주세요." };
    }
    if (host.endsWith("github.com") || host.endsWith("google.com")) {
      return { ok: false, error: "이건 나눔보드 주소가 아니에요. 끝이 .workers.dev 인 주소를 찾아 주세요." };
    }
    if (!host.includes(".")) return { ok: false, error: "주소가 짧아요. 끝이 .workers.dev 인 전체 주소를 붙여 넣어 주세요." };
  }
  const origin = u.origin;
  const extra = u.pathname !== "/" || u.search || u.hash;
  const notes: string[] = [];
  if (extra) notes.push(`뒷부분(${u.pathname}${u.search}${u.hash})은 떼어 냈어요.`);
  if (!local && !host.endsWith(".workers.dev")) notes.push("끝이 .workers.dev 가 아니에요. 직접 연결한 도메인이라면 괜찮아요.");
  else if (!local && host.split(".").length < 4) {
    notes.push("보통은 ‘이름.내하위도메인.workers.dev’처럼 점이 3개예요. 주소 전체를 복사했는지 확인해 주세요.");
  }
  return notes.length ? { ok: true, value: origin, note: notes.join(" ") } : { ok: true, value: origin };
}

/** Google OAuth 클라이언트 보안 비밀번호처럼 보이는가 (이 페이지에 붙여 넣으면 안 되는 값) */
export function looksLikeClientSecret(raw: string): boolean {
  const s = cleanPasted(raw);
  return /^GOCSPX-[\w-]{10,}$/.test(s);
}

/** 클라이언트 ID 검사. 모양: 숫자-영숫자.apps.googleusercontent.com */
export function checkClientId(raw: string): Check<string> {
  const s = cleanPasted(raw);
  if (!s) return { ok: false, error: "클라이언트 ID를 붙여 넣어 주세요." };
  if (looksLikeClientSecret(s)) {
    return { ok: false, error: "이건 ‘클라이언트 보안 비밀번호’예요! 이 페이지에는 넣지 마세요. 비밀번호는 Cloudflare에만 넣어요." };
  }
  if (/\s/.test(s)) return { ok: false, error: "중간에 띄어쓰기가 있어요. 클라이언트 ID만 다시 복사해 주세요." };
  if (s.startsWith("http")) return { ok: false, error: "주소가 아니라 ‘클라이언트 ID’를 붙여 넣어 주세요." };
  if (!s.endsWith(".apps.googleusercontent.com")) {
    if (/^\d+-[a-z0-9]+$/i.test(s)) return { ok: false, error: "뒷부분이 잘렸어요. 끝이 .apps.googleusercontent.com 까지 모두 복사해 주세요." };
    return { ok: false, error: "클라이언트 ID는 끝이 .apps.googleusercontent.com 이에요." };
  }
  if (!/^\d+-[a-z0-9]+\.apps\.googleusercontent\.com$/.test(s)) {
    return { ok: false, error: "모양이 조금 달라요. Google 화면의 ‘클라이언트 ID’ 옆 복사 버튼으로 다시 복사해 주세요." };
  }
  return { ok: true, value: s };
}

/** 이메일 검사 (OWNER_EMAIL 용, 선택) */
export function checkEmail(raw: string): Check<string> {
  const s = cleanPasted(raw).toLowerCase();
  if (!s) return { ok: false, error: "이메일 주소를 적어 주세요." };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return { ok: false, error: "이메일 주소 모양이 아니에요. 예: teacher@gmail.com" };
  return { ok: true, value: s };
}

/** 나눔보드 주소로 Google 에 넣을 값들을 만든다 */
export function derivedFromOrigin(origin: string) {
  return {
    origin,
    redirectUri: `${origin}/auth/google/callback`,
    jsOrigin: origin,
    setupUrl: `${origin}/setup`,
    checkUrl: `${origin}/setup#check`,
    loginUrl: `${origin}/auth/google`,
    teacherUrl: `${origin}/teacher`,
    /** Cloudflare 대시보드에서 찾을 Worker 이름 (주소 맨 앞 부분) */
    workerName: new URL(origin).hostname.endsWith(".workers.dev") ? new URL(origin).hostname.split(".")[0]! : null,
  };
}
