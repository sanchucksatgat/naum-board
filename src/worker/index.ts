import { Hono } from "hono";
import type { Env } from "./env";
import { HttpError } from "./http";
import { authRoutes } from "./auth";
import { driveRoutes, setDriveDeps } from "./drive";
import { authenticateBoardActor } from "./board/actor";
import { boardRoutes } from "./board/routes";
import { teacherRoutes } from "./registry/routes";
import { setupRoutes } from "./setup/routes";

export { Registry } from "./registry";
export { Board } from "./board";

const app = new Hono<{ Bindings: Env }>();

// 각 태스크는 자기 라우터를 여기 한 줄로 붙인다 (예: app.route("/", boardRoutes)).
app.route("/", authRoutes);
app.route("/", driveRoutes);
app.route("/", boardRoutes);
app.route("/", teacherRoutes);
app.route("/", setupRoutes);

// 태스크3 Drive 라우트가 학생도 인식하도록 태스크2 인증을 연결한다.
setDriveDeps({ authenticateBoardActor });

app.notFound((c) => {
  const path = new URL(c.req.url).pathname;
  if (path.startsWith("/api/") || path.startsWith("/auth/")) {
    return c.json({ error: { code: "not_found", message: "찾을 수 없어요." } }, 404);
  }
  // run_worker_first 밖의 경로는 원래 정적 자산이 처리하지만, 혹시 넘어오면 자산으로 넘긴다.
  return c.env.ASSETS.fetch(c.req.raw);
});

app.onError((err, c) => {
  if (err instanceof HttpError) return err.toResponse();
  console.error("unhandled error", err);
  return c.json({ error: { code: "internal", message: "잠시 문제가 생겼어요. 다시 시도해 주세요." } }, 500);
});

export default app satisfies ExportedHandler<Env>;
