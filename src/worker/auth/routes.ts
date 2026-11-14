import { Hono } from "hono";
import type { DriveStatus, MeResponse } from "../../shared/api";
import { readVar, type Env } from "../env";
import { htmlPage, type PageLink } from "../http";
import { getRegistry } from "../stubs";
import { forgetIsolateAccessToken, GoogleAccessError, getGoogleAccessToken } from "./access";
import { clearCookie, getCookie, serializeCookie } from "./cookies";
import { buildAuthorizationUrl, DRIVE_FILE_SCOPE, exchangeAuthorizationCode, GoogleTokenError, pkceChallenge, readIdToken } from "./google";
import { getSigningSecret } from "./secret";
import { clearSessionCookie, createSessionCookie, forgetOwnerCache, getTeacher } from "./session";
import { randomToken, signToken, timingSafeEqualStr, verifyToken } from "./token";

export const OAUTH_STATE_COOKIE = "__Host-nb_oauth";
const OAUTH_STATE_PURPOSE = "oauth_state";
const OAUTH_STATE_TTL = 10 * 60;
const AFTER_LOGIN = "/teacher";

export function callbackUrl(request: Request): string {
  return `${new URL(request.url).origin}/auth/google/callback`;
}

function googleConfig(env: Env) {
  const clientId = readVar(env, "GOOGLE_CLIENT_ID");
  const clientSecret = readVar(env, "GOOGLE_CLIENT_SECRET");
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

const notConfiguredPage = () =>
  htmlPage(503, "설정이 필요해요", "Google 로그인 설정(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET)이 아직 없어요. 설치 안내를 따라 설정해 주세요.", [
    { href: "/setup#check", label: "설치 안내에서 이어 하기" },
    { href: "/setup#help-not-configured", label: "넣었는데도 이 화면이 나와요" },
  ]);

/** 설치 안내(/setup)의 "자주 막히는 곳" 항목으로 가는 링크. 키는 web/setup/help.tsx 의 HELP 키. */
const helpLink = (id: string, label = "해결 방법 보기"): PageLink => ({ href: `/setup#help-${id}`, label });

export const authRoutes = new Hono<{ Bindings: Env }>();

/** 로그인 시작: Google 동의 화면으로 보낸다. */
authRoutes.get("/auth/google", async (c) => {
  const cfg = googleConfig(c.env);
  if (!cfg) return notConfiguredPage();
  const state = randomToken(24);
  const verifier = randomToken(48);
  const secret = await getSigningSecret(c.env);
  const cookieValue = await signToken(secret, OAUTH_STATE_PURPOSE, { s: state, v: verifier }, OAUTH_STATE_TTL);
  const url = buildAuthorizationUrl({
    clientId: cfg.clientId,
    redirectUri: callbackUrl(c.req.raw),
    state,
    codeChallenge: await pkceChallenge(verifier),
    loginHint: readVar(c.env, "OWNER_EMAIL"),
  });
  return new Response(null, {
    status: 302,
    headers: {
      location: url,
      "set-cookie": serializeCookie(OAUTH_STATE_COOKIE, cookieValue, { maxAge: OAUTH_STATE_TTL }),
      "cache-control": "no-store",
    },
  });
});

/** Google 이 돌려보내는 곳. state 확인 → 코드 교환 → 소유자 확인 → 세션 발급. */
authRoutes.get("/auth/google/callback", async (c) => {
  const cfg = googleConfig(c.env);
  if (!cfg) return notConfiguredPage();
  const url = new URL(c.req.url);
  const retry: PageLink = { href: "/auth/google", label: "다시 로그인하기" };
  const fail = (status: number, title: string, msg: string, link: PageLink | PageLink[] = retry) => {
    const res = htmlPage(status, title, msg, link);
    res.headers.append("set-cookie", clearCookie(OAUTH_STATE_COOKIE));
    return res;
  };

  // 1) state (CSRF) 확인: 쿠키에 서명해 둔 값과 주소의 state 가 같아야 한다.
  const secret = await getSigningSecret(c.env);
  const saved = await verifyToken<{ s: string; v: string }>(secret, OAUTH_STATE_PURPOSE, getCookie(c.req.raw, OAUTH_STATE_COOKIE));
  const state = url.searchParams.get("state") ?? "";
  if (!saved || typeof saved.s !== "string" || typeof saved.v !== "string" || !timingSafeEqualStr(saved.s, state)) {
    return fail(400, "로그인을 다시 시작해 주세요", "로그인 요청이 만료되었거나 올바르지 않아요.");
  }

  const oauthErr = url.searchParams.get("error");
  if (oauthErr) {
    return fail(
      400,
      "로그인이 취소되었어요",
      "Google 로그인 화면에서 허용하지 않았어요. 다시 시도해 주세요. 계속 이렇다면 Google Cloud의 앱이 아직 ‘테스트 중’이거나 다른 계정을 골랐을 수 있어요.",
      [retry, helpLink("access-denied")],
    );
  }
  const code = url.searchParams.get("code");
  if (!code) return fail(400, "로그인을 다시 시작해 주세요", "Google 에서 받은 정보가 없어요.");

  // 2) 코드 교환
  let tokens;
  try {
    tokens = await exchangeAuthorizationCode({
      clientId: cfg.clientId,
      clientSecret: cfg.clientSecret,
      code,
      redirectUri: callbackUrl(c.req.raw),
      codeVerifier: saved.v,
    });
  } catch (e) {
    const err = e instanceof GoogleTokenError ? e.oauthError : "";
    if (err === "invalid_client" || err === "unauthorized_client") {
      return fail(
        502,
        "Google 설정 값이 맞지 않아요",
        "Cloudflare에 넣은 GOOGLE_CLIENT_ID 또는 GOOGLE_CLIENT_SECRET이 Google에서 만든 클라이언트와 맞지 않아요. 값을 다시 확인해 주세요.",
        [helpLink("secret"), retry],
      );
    }
    if (err === "redirect_uri_mismatch") {
      return fail(502, "주소 설정이 맞지 않아요", "Google 클라이언트의 ‘승인된 리디렉션 URI’가 이 나눔보드 주소와 달라요.", [helpLink("redirect"), retry]);
    }
    return fail(502, "로그인하지 못했어요", "Google 과 연결하는 중 문제가 생겼어요. 잠시 후 다시 시도해 주세요.");
  }
  const claims = tokens.id_token ? readIdToken(tokens.id_token, cfg.clientId) : null;
  const verified = claims?.email_verified === true || claims?.email_verified === "true";
  if (!claims || !claims.email || !verified) {
    return fail(400, "로그인하지 못했어요", "Google 계정의 이메일을 확인할 수 없어요.");
  }
  const email = claims.email.toLowerCase();

  // 3) OWNER_EMAIL 이 있으면 그 계정만
  const ownerEmail = readVar(c.env, "OWNER_EMAIL")?.toLowerCase() ?? null;
  if (ownerEmail && email !== ownerEmail) {
    return fail(403, "이 계정으로는 들어올 수 없어요", "이 나눔보드는 지정된 교사 계정만 사용할 수 있어요. 다른 Google 계정으로 로그인해 주세요.", [
      retry,
      helpLink("owner", "주인 계정 바꾸는 법"),
    ]);
  }

  // 4) 소유자 확인 (최초 로그인 계정이 소유자)
  const result = await getRegistry(c.env).claimOwner({
    sub: claims.sub,
    email,
    refreshToken: tokens.refresh_token ?? null,
    scope: tokens.scope ?? "",
    ownerEmail,
  });
  if (!result.ok) {
    return fail(403, "이 계정으로는 들어올 수 없어요", "이 나눔보드는 이미 다른 교사 계정에 연결되어 있어요. 처음 연결한 계정으로 로그인해 주세요.", [
      retry,
      helpLink("owner", "주인 계정 바꾸는 법"),
    ]);
  }
  forgetOwnerCache();
  forgetIsolateAccessToken();

  const headers = new Headers({ location: AFTER_LOGIN, "cache-control": "no-store" });
  headers.append("set-cookie", clearCookie(OAUTH_STATE_COOKIE));
  headers.append("set-cookie", await createSessionCookie(c.env, { sub: claims.sub, email }));
  return new Response(null, { status: 302, headers });
});

/** 로그아웃: 이 브라우저의 세션 쿠키 삭제. */
authRoutes.post("/auth/logout", (c) => {
  // SameSite=Lax 로 교차 사이트 POST 에는 쿠키가 안 붙지만, Origin 도 확인한다.
  const origin = c.req.header("origin");
  if (origin && origin !== new URL(c.req.url).origin) {
    return c.json({ error: { code: "bad_origin", message: "잘못된 요청이에요." } }, 403);
  }
  return new Response(null, { status: 204, headers: { "set-cookie": clearSessionCookie(), "cache-control": "no-store" } });
});

/** 현재 로그인 상태 + 설치 상태 + Drive 연결 상태 */
authRoutes.get("/api/me", async (c) => {
  const registry = getRegistry(c.env);
  const owner = await registry.getOwner();
  const body: MeResponse = {
    authenticated: false,
    setup: { googleConfigured: googleConfig(c.env) !== null, ownerClaimed: owner !== null },
  };
  const teacher = owner ? await getTeacher(c.req.raw, c.env) : null;
  if (teacher && owner) {
    body.authenticated = true;
    body.teacher = { email: owner.email };
    body.drive = { status: await driveStatus(c.env, owner.scopes, owner.needsReconnect || !owner.hasRefreshToken) };
  }
  return c.json(body, 200, { "cache-control": "no-store" });
});

async function driveStatus(env: Env, scopes: string[], needsReconnect: boolean): Promise<DriveStatus> {
  if (!scopes.includes(DRIVE_FILE_SCOPE)) return "missing_scope";
  if (needsReconnect) return "reconnect_required";
  try {
    await getGoogleAccessToken(env);
    return "ok";
  } catch (e) {
    if (e instanceof GoogleAccessError && e.reason === "reconnect_required") return "reconnect_required";
    return "unavailable";
  }
}
