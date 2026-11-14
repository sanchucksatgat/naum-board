import { Hono, type Context } from "hono";
import type { Env } from "../env";
import { HttpError } from "../http";
import { requireTeacher } from "../auth";
import { createUpload, completeUpload, proxyUpload } from "./uploads";
import { serveFile } from "./files";
import { boardDriveInfo, exportBoard } from "./export";

type C = Context<{ Bindings: Env }>;

/** 쓰기 요청이 다른 사이트에서 온 것이면 막는다 (CSRF). */
function sameOrigin(c: C): void {
  const o = c.req.header("origin");
  if (!o) return;
  const self = new URL(c.req.url);
  const local = (h: string) => h === "localhost" || h === "127.0.0.1";
  try {
    const ou = new URL(o);
    // 같은 출처만. 개발 중(localhost 서버)에만 localhost 의 다른 포트(vite 개발 서버)를 허용한다.
    if (ou.host === self.host || (local(self.hostname) && local(ou.hostname))) return;
  } catch {
    /* 아래 */
  }
  throw new HttpError(403, "bad_origin", "다른 사이트에서 온 요청은 처리할 수 없어요.");
}

function requireJson(c: C): void {
  const ct = c.req.header("content-type") ?? "";
  if (!ct.toLowerCase().startsWith("application/json")) throw new HttpError(415, "json_required", "요청 형식이 올바르지 않아요.");
}

function execCtx(c: C): ExecutionContext | undefined {
  try {
    return c.executionCtx as ExecutionContext;
  } catch {
    return undefined;
  }
}

const noStore = { "cache-control": "no-store" };

export const driveRoutes = new Hono<{ Bindings: Env }>();

driveRoutes.post("/api/boards/:code/uploads", async (c) => {
  sameOrigin(c);
  requireJson(c);
  return c.json(await createUpload(c.req.raw, c.env, c.req.param("code")), 200, noStore);
});

driveRoutes.put("/api/boards/:code/uploads/:uploadId/proxy", async (c) => {
  sameOrigin(c);
  return c.json(await proxyUpload(c.req.raw, c.env, c.req.param("code"), c.req.param("uploadId")), 200, noStore);
});

driveRoutes.post("/api/boards/:code/uploads/:uploadId/complete", async (c) => {
  sameOrigin(c);
  requireJson(c);
  return c.json(await completeUpload(c.req.raw, c.env, c.req.param("code"), c.req.param("uploadId")), 200, noStore);
});

driveRoutes.get("/api/files/:boardId/:attachmentId", (c) =>
  serveFile(c.req.raw, c.env, execCtx(c), c.req.param("boardId"), c.req.param("attachmentId")),
);

driveRoutes.post("/api/boards/:code/export", async (c) => {
  sameOrigin(c);
  await requireTeacher(c.req.raw, c.env);
  return c.json(await exportBoard(c.env, c.req.param("code")), 200, noStore);
});

driveRoutes.get("/api/boards/:code/drive", async (c) => {
  await requireTeacher(c.req.raw, c.env);
  return c.json(await boardDriveInfo(c.env, c.req.param("code")), 200, noStore);
});
