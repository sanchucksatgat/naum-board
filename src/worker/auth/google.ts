/** Google OAuth 2.0 / OpenID Connect 저수준 호출. (Drive API 호출은 src/worker/drive, 태스크3) */
import { base64UrlDecode, base64UrlEncode } from "./token";

export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";
export const GOOGLE_SCOPES = ["openid", "email", DRIVE_FILE_SCOPE] as const;

export function buildAuthorizationUrl(opts: {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  loginHint?: string;
}): string {
  const u = new URL(GOOGLE_AUTH_URL);
  u.searchParams.set("client_id", opts.clientId);
  u.searchParams.set("redirect_uri", opts.redirectUri);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", GOOGLE_SCOPES.join(" "));
  u.searchParams.set("access_type", "offline");
  u.searchParams.set("prompt", "consent");
  u.searchParams.set("state", opts.state);
  u.searchParams.set("code_challenge", opts.codeChallenge);
  u.searchParams.set("code_challenge_method", "S256");
  if (opts.loginHint) u.searchParams.set("login_hint", opts.loginHint);
  return u.toString();
}

export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64UrlEncode(digest);
}

export interface GoogleTokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
  id_token?: string;
  token_type?: string;
}

export class GoogleTokenError extends Error {
  constructor(
    readonly status: number,
    /** Google 의 error 값 (예: invalid_grant, invalid_client) */
    readonly oauthError: string,
  ) {
    super(`Google token endpoint error: ${status} ${oauthError}`);
    this.name = "GoogleTokenError";
  }
}

async function postToken(params: Record<string, string>): Promise<GoogleTokenResponse> {
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(params).toString(),
  });
  let data: Record<string, unknown> = {};
  try {
    data = (await res.json()) as Record<string, unknown>;
  } catch {
    /* 본문 없음 */
  }
  if (!res.ok || typeof data.access_token !== "string") {
    throw new GoogleTokenError(res.status, typeof data.error === "string" ? data.error : "unknown_error");
  }
  return data as unknown as GoogleTokenResponse;
}

export function exchangeAuthorizationCode(opts: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
  codeVerifier: string;
}): Promise<GoogleTokenResponse> {
  return postToken({
    grant_type: "authorization_code",
    code: opts.code,
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
    redirect_uri: opts.redirectUri,
    code_verifier: opts.codeVerifier,
  });
}

export function refreshAccessToken(opts: { clientId: string; clientSecret: string; refreshToken: string }): Promise<GoogleTokenResponse> {
  return postToken({
    grant_type: "refresh_token",
    refresh_token: opts.refreshToken,
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
  });
}

export interface IdTokenClaims {
  iss: string;
  aud: string;
  sub: string;
  email?: string;
  email_verified?: boolean | string;
  exp: number;
}

/**
 * id_token 클레임 읽기.
 * 토큰 엔드포인트에서 TLS로 직접 받은 id_token 이므로 서명 검증 대신 iss/aud/exp 만 확인한다
 * (OpenID Connect Core 3.1.3.7 의 허용 사항).
 */
export function readIdToken(idToken: string, clientId: string): IdTokenClaims | null {
  const parts = idToken.split(".");
  if (parts.length !== 3) return null;
  let c: IdTokenClaims;
  try {
    c = JSON.parse(new TextDecoder().decode(base64UrlDecode(parts[1]!))) as IdTokenClaims;
  } catch {
    return null;
  }
  if (c.iss !== "https://accounts.google.com" && c.iss !== "accounts.google.com") return null;
  if (c.aud !== clientId) return null;
  if (typeof c.exp !== "number" || c.exp * 1000 < Date.now() - 5 * 60_000) return null;
  if (typeof c.sub !== "string" || !c.sub) return null;
  return c;
}
