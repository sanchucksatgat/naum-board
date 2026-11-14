import { DurableObject } from "cloudflare:workers";
import { readVar, type Env } from "../env";
import { GoogleTokenError, refreshAccessToken } from "../auth/google";
import { randomToken } from "../auth/token";
import { applyMigrations, REGISTRY_MIGRATIONS } from "./migrations";
import { claimOwner, readOwner, toOwnerInfo, type ClaimOwnerInput, type ClaimOwnerResult, type OwnerInfo } from "./owner";

export type { ClaimOwnerInput, ClaimOwnerResult, OwnerInfo } from "./owner";

/** getAccessToken RPC 결과. RPC 로는 사용자 정의 예외가 그대로 넘어가지 않으므로 결과 값으로 돌려준다. */
export type AccessTokenResult =
  | { ok: true; accessToken: string; expiresAt: number }
  | { ok: false; reason: GoogleAccessFailure };

/**
 * - not_configured: GOOGLE_CLIENT_ID/SECRET 없음 또는 Google 이 클라이언트를 거부(invalid_client)
 * - not_connected: 아직 소유자가 로그인한 적 없음
 * - reconnect_required: refresh token 이 없거나 만료·취소됨 (교사가 다시 로그인해야 함)
 * - google_error: 일시 오류 (재시도 가능)
 */
export type GoogleAccessFailure = "not_configured" | "not_connected" | "reconnect_required" | "google_error";

/** 접근 토큰은 만료 이 시간 전에 미리 갱신 */
export const ACCESS_TOKEN_SKEW_MS = 60_000;

/**
 * Registry DO: 인스턴스당 하나 (getRegistry(env) 로 접근). 소유자·서명 키·Google 토큰을 보관.
 * 태스크2가 보드/반/명단 메서드를 이 클래스에 추가한다 (마이그레이션은 migrations.ts 끝에 추가).
 */
export class Registry extends DurableObject<Env> {
  protected readonly sql: SqlStorage;
  private tokenCache: { accessToken: string; expiresAt: number } | null = null;
  private refreshing: Promise<AccessTokenResult> | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => {
      applyMigrations(ctx.storage, REGISTRY_MIGRATIONS);
    });
  }

  // ---- 서명 키 ----

  /** SESSION_SECRET 이 설정되지 않았을 때 쓰는 서명 키. 처음 호출 때 만들어 영구 보관. */
  getOrCreateSessionSecret(): string {
    const row = this.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = 'session_secret'").toArray()[0];
    if (row) return row.value;
    const secret = randomToken(48);
    this.sql.exec("INSERT INTO meta (key, value) VALUES ('session_secret', ?)", secret);
    return secret;
  }

  // ---- 소유자 ----

  getOwner(): OwnerInfo | null {
    const r = readOwner(this.sql);
    return r ? toOwnerInfo(r) : null;
  }

  claimOwner(input: ClaimOwnerInput): ClaimOwnerResult {
    const result = this.ctx.storage.transactionSync(() => claimOwner(this.sql, input, Date.now()));
    if (result.ok) this.tokenCache = null;
    return result;
  }

  /** 태스크3(Drive)용: 나눔보드 최상위 폴더 id 저장/조회 */
  getDriveRootId(): string | null {
    return readOwner(this.sql)?.drive_root_id ?? null;
  }

  setDriveRootId(id: string | null): void {
    this.sql.exec("UPDATE owner SET drive_root_id = ?, updated_at = ? WHERE id = 1", id, Date.now());
  }

  // ---- Google 접근 토큰 ----

  /** 캐시된 접근 토큰을 주거나, refresh token 으로 새로 받는다. 동시 요청은 한 번의 갱신을 공유. */
  async getAccessToken(): Promise<AccessTokenResult> {
    const c = this.tokenCache;
    if (c && c.expiresAt - ACCESS_TOKEN_SKEW_MS > Date.now()) return { ok: true, ...c };
    if (!this.refreshing) {
      this.refreshing = this.refreshNow().finally(() => {
        this.refreshing = null;
      });
    }
    return this.refreshing;
  }

  /** Drive API 가 401 을 주면 호출: 캐시를 버려 다음 getAccessToken 이 새로 받게 한다. */
  invalidateAccessToken(): void {
    this.tokenCache = null;
  }

  private async refreshNow(): Promise<AccessTokenResult> {
    const owner = readOwner(this.sql);
    if (!owner) return { ok: false, reason: "not_connected" };
    if (owner.needs_reconnect === 1 || !owner.refresh_token) return { ok: false, reason: "reconnect_required" };
    const clientId = readVar(this.env, "GOOGLE_CLIENT_ID");
    const clientSecret = readVar(this.env, "GOOGLE_CLIENT_SECRET");
    if (!clientId || !clientSecret) return { ok: false, reason: "not_configured" };
    const usedToken = owner.refresh_token;
    try {
      const t = await refreshAccessToken({ clientId, clientSecret, refreshToken: usedToken });
      const expiresAt = Date.now() + Math.max(60, t.expires_in) * 1000;
      // 갱신 중에 소유자가 바뀌었으면 결과를 버린다.
      if (readOwner(this.sql)?.refresh_token !== usedToken) return { ok: false, reason: "google_error" };
      if (t.refresh_token && t.refresh_token !== usedToken) {
        this.sql.exec("UPDATE owner SET refresh_token = ?, updated_at = ? WHERE id = 1", t.refresh_token, Date.now());
      }
      this.tokenCache = { accessToken: t.access_token, expiresAt };
      return { ok: true, accessToken: t.access_token, expiresAt };
    } catch (e) {
      if (e instanceof GoogleTokenError) {
        if (e.oauthError === "invalid_grant") {
          // 만료·취소·비밀번호 변경 등: 다시 연결할 때까지 Google 을 다시 부르지 않는다.
          this.sql.exec(
            "UPDATE owner SET needs_reconnect = 1, updated_at = ? WHERE id = 1 AND refresh_token = ?",
            Date.now(),
            usedToken,
          );
          this.tokenCache = null;
          return { ok: false, reason: "reconnect_required" };
        }
        if (e.oauthError === "invalid_client" || e.oauthError === "unauthorized_client") {
          return { ok: false, reason: "not_configured" };
        }
      }
      return { ok: false, reason: "google_error" };
    }
  }
}
