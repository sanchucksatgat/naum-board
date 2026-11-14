/** Worker 쪽 도구: RPC 결과 → HTTP 오류, 명단을 연결된 보드로 밀어 넣기. 태스크2. */
import type { Context } from "hono";
import type { Env } from "../env";
import { HttpError } from "../http";
import { getBoardStub, getRegistry } from "../stubs";
import type { RpcResult } from "../board/validate";

/** retryAfterMs 를 실어 보내는 HttpError */
export class RetryableHttpError extends HttpError {
  constructor(status: number, code: string, message: string, readonly retryAfterMs?: number) {
    super(status, code, message);
  }

  override toResponse(): Response {
    const headers: Record<string, string> = { "cache-control": "no-store" };
    const body: { error: { code: string; message: string; retryAfterMs?: number } } = { error: { code: this.code, message: this.message } };
    if (this.retryAfterMs !== undefined) {
      body.error.retryAfterMs = this.retryAfterMs;
      headers["retry-after"] = String(Math.max(1, Math.ceil(this.retryAfterMs / 1000)));
    }
    return Response.json(body, { status: this.status, headers });
  }
}

export function unwrap<T>(r: RpcResult<T>): T {
  if (r.ok) return r.value;
  throw new RetryableHttpError(r.status, r.code, r.message, r.retryAfterMs);
}

export async function readJson(c: Context): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new HttpError(400, "bad_request", "요청 내용이 올바르지 않아요.");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "bad_request", "요청 내용이 올바르지 않아요.");
  return body as Record<string, unknown>;
}

/** 쿠키로 인증하는 쓰기 요청: 다른 사이트 Origin 거부 */
export function assertSameOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) throw new HttpError(403, "forbidden", "잘못된 요청이에요.");
}

/** 반 명단이 바뀌었을 때: 그 반에 연결된 모든 보드에 새 명단 사본을 보낸다 */
export async function syncClassRoster(env: Env, classId: string): Promise<void> {
  const { boardIds, members } = await getRegistry(env).rosterSync(classId);
  await Promise.all(boardIds.map((id) => getBoardStub(env, id).setRoster(members)));
}

/** 보드 하나의 명단 사본을 Registry 원본에 맞춘다 */
export async function syncBoardRoster(env: Env, boardId: string): Promise<void> {
  const members = await getRegistry(env).rosterForBoard(boardId);
  await getBoardStub(env, boardId).setRoster(members);
}
