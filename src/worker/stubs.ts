import type { Env } from "./env";

/** Registry DO는 인스턴스당 하나. 이름 고정. */
export const REGISTRY_NAME = "registry";

/** Registry DO stub (RPC). 예: `await getRegistry(env).getOwner()` */
export function getRegistry(env: Env) {
  return env.REGISTRY.get(env.REGISTRY.idFromName(REGISTRY_NAME));
}

/** 보드 id(Registry의 boards.id)로 Board DO stub을 얻는다. 입장코드가 아니라 내부 id를 쓴다. */
export function getBoardStub(env: Env, boardId: string) {
  return env.BOARD.get(env.BOARD.idFromName(`board:${boardId}`));
}
