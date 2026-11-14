/** 소유자(교사) 관련 SQL. Registry DO 안에서만 호출. */

export interface OwnerRow {
  sub: string;
  email: string;
  refresh_token: string | null;
  scope: string;
  needs_reconnect: number;
  drive_root_id: string | null;
  created_at: number;
  updated_at: number;
}

/** RPC로 밖에 내보내는 소유자 정보 (refresh token 은 절대 내보내지 않음). */
export interface OwnerInfo {
  sub: string;
  email: string;
  hasRefreshToken: boolean;
  needsReconnect: boolean;
  scopes: string[];
  driveRootId: string | null;
}

export interface ClaimOwnerInput {
  sub: string;
  email: string;
  /** 이번 로그인에서 받은 refresh token (없으면 기존 값 유지) */
  refreshToken: string | null;
  /** 이번 로그인에서 허용된 scope (공백 구분) */
  scope: string;
  /** OWNER_EMAIL 설정값 (소문자). Worker에서 이미 일치 여부를 확인한 뒤 넘긴다. */
  ownerEmail: string | null;
}

export type ClaimOwnerResult =
  | { ok: true; outcome: "claimed" | "returning" | "transferred" }
  | { ok: false; reason: "other_owner" };

export function readOwner(sql: SqlStorage): OwnerRow | null {
  const rows = sql.exec<OwnerRow & Record<string, SqlStorageValue>>("SELECT * FROM owner WHERE id = 1").toArray();
  return rows[0] ?? null;
}

export function toOwnerInfo(r: OwnerRow): OwnerInfo {
  return {
    sub: r.sub,
    email: r.email,
    hasRefreshToken: !!r.refresh_token,
    needsReconnect: r.needs_reconnect === 1,
    scopes: r.scope.split(/\s+/).filter(Boolean),
    driveRootId: r.drive_root_id,
  };
}

/**
 * 소유자 규칙 (DESIGN §4):
 * - 소유자가 없으면 이 계정이 소유자가 된다.
 * - 같은 sub 이면 이메일·토큰·scope 갱신.
 * - 다른 sub 이면 거부. 단, OWNER_EMAIL 이 설정돼 있고 기존 소유자의 이메일이 그와 다르면
 *   (OWNER_EMAIL 을 나중에 설정해 소유자를 바로잡는 경우) OWNER_EMAIL 계정으로 소유권을 넘긴다.
 *   이때 이전 계정의 Drive 정보(refresh token, drive_root_id)는 지운다.
 */
export function claimOwner(sql: SqlStorage, input: ClaimOwnerInput, now: number): ClaimOwnerResult {
  const cur = readOwner(sql);
  if (!cur) {
    sql.exec(
      `INSERT INTO owner (id, sub, email, refresh_token, scope, needs_reconnect, drive_root_id, created_at, updated_at)
       VALUES (1, ?, ?, ?, ?, 0, NULL, ?, ?)`,
      input.sub, input.email, input.refreshToken, input.scope, now, now,
    );
    return { ok: true, outcome: "claimed" };
  }
  if (cur.sub === input.sub) {
    sql.exec(
      `UPDATE owner SET email = ?, refresh_token = COALESCE(?, refresh_token), scope = ?,
         needs_reconnect = CASE WHEN ? IS NULL THEN needs_reconnect ELSE 0 END, updated_at = ? WHERE id = 1`,
      input.email, input.refreshToken, input.scope, input.refreshToken, now,
    );
    return { ok: true, outcome: "returning" };
  }
  if (input.ownerEmail && input.email.toLowerCase() === input.ownerEmail && cur.email.toLowerCase() !== input.ownerEmail) {
    sql.exec(
      `UPDATE owner SET sub = ?, email = ?, refresh_token = ?, scope = ?, needs_reconnect = 0,
         drive_root_id = NULL, created_at = ?, updated_at = ? WHERE id = 1`,
      input.sub, input.email, input.refreshToken, input.scope, now, now,
    );
    return { ok: true, outcome: "transferred" };
  }
  return { ok: false, reason: "other_owner" };
}
