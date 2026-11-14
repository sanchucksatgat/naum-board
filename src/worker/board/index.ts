import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";

/**
 * Board DO 자리표시자. 보드당 하나 (getBoardStub(env, boardId)).
 * 태스크2가 이 디렉터리 전체(실시간 프로토콜, WebSocket Hibernation, SQLite 스키마)로 교체한다.
 * 클래스 이름 "Board" 와 export 위치(src/worker/board/index.ts)는 wrangler.jsonc 마이그레이션과 묶여 있으니 유지할 것.
 */
export class Board extends DurableObject<Env> {
  override async fetch(_request: Request): Promise<Response> {
    return Response.json({ error: { code: "not_implemented", message: "보드 기능은 아직 준비 중이에요." } }, { status: 501 });
  }
}
