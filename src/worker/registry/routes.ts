/**
 * 교사 관리 REST (teacherOnly). 태스크2. 자세한 모양은 docs/PROTOCOL.md 와 src/shared/protocol.ts.
 */
import { Hono } from "hono";
import type { Env } from "../env";
import { getSigningSecret, signToken, teacherOnly, type TeacherVariables } from "../auth";
import { FILE_VIEW_TOKEN_PURPOSE, type FileViewTokenPayload } from "../../shared/files";
import { HttpError } from "../http";
import { getBoardStub, getRegistry } from "../stubs";
import {
  type AddStudentsResponse, type BoardDetail, type BoardSettings, type ClassSummary, type PortfolioResponse, type RecentPostsResponse,
  type ResetPinResponse, type StudentRowInput, type TeacherStudent,
} from "../../shared/protocol";
import { checkSettingsCombination, DEFAULT_SETTINGS, parseSettingsPatch } from "../board/settings";
import { ValidationError } from "../board/validate";
import { assertSameOrigin, readJson, syncBoardRoster, syncClassRoster, unwrap } from "./sync";

type HonoEnv = { Bindings: Env; Variables: TeacherVariables };
export const teacherRoutes = new Hono<HonoEnv>();

teacherRoutes.use("/api/teacher/*", teacherOnly);
teacherRoutes.use("/api/teacher/*", async (c, next) => {
  if (c.req.method !== "GET" && c.req.method !== "HEAD") assertSameOrigin(c.req.raw);
  await next();
});

const noStore = { "cache-control": "no-store" };

function validated<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof ValidationError) throw new HttpError(e.status, e.code, e.message);
    throw e;
  }
}

async function boardDetail(env: Env, id: string): Promise<BoardDetail> {
  const [summary, detail] = await Promise.all([getRegistry(env).getBoardSummary(id), getBoardStub(env, id).getTeacherDetail()]);
  if (!summary || !detail) throw new HttpError(404, "not_found", "보드를 찾을 수 없어요.");
  return { ...summary, settings: detail.settings, backup: detail.backup };
}

// ───── 보드 ─────

teacherRoutes.get("/api/teacher/boards", async (c) => {
  const f = c.req.query("archived");
  const filter = f === "1" || f === "true" ? "archived" : f === "all" ? "all" : "active";
  return c.json({ boards: await getRegistry(c.env).listBoards(filter) }, 200, noStore);
});

teacherRoutes.post("/api/teacher/boards", async (c) => {
  const body = await readJson(c);
  const { classId, ...rest } = body;
  const patch = validated(() => parseSettingsPatch(rest));
  if (!patch.title) throw new HttpError(400, "bad_request", "보드 제목을 입력해 주세요.");
  const settings: BoardSettings = { ...DEFAULT_SETTINGS, ...patch, title: patch.title, archived: false };
  validated(() => checkSettingsCombination(settings));
  const cls = classId === undefined || classId === null || classId === "" ? null : String(classId);
  const reg = getRegistry(c.env);
  const rec = unwrap(
    await reg.createBoard({ title: settings.title, type: settings.type, columnMode: settings.columnMode, entryMode: settings.entryMode, classId: cls, locked: settings.locked }),
  );
  const board = getBoardStub(c.env, rec.id);
  const init = await board.init({ boardId: rec.id, code: rec.code, settings });
  if (!init.ok) {
    await reg.deleteBoard(rec.id);
    unwrap(init);
  }
  if (cls) await syncBoardRoster(c.env, rec.id);
  return c.json(await boardDetail(c.env, rec.id), 201, noStore);
});

teacherRoutes.get("/api/teacher/boards/:id", async (c) => c.json(await boardDetail(c.env, c.req.param("id")), 200, noStore));

teacherRoutes.patch("/api/teacher/boards/:id", async (c) => {
  const id = c.req.param("id");
  if (!(await getRegistry(c.env).getBoardRecord(id))) throw new HttpError(404, "not_found", "보드를 찾을 수 없어요.");
  unwrap(await getBoardStub(c.env, id).updateSettings(await readJson(c)));
  return c.json(await boardDetail(c.env, id), 200, noStore);
});

for (const [path, archived] of [["archive", true], ["unarchive", false]] as const) {
  teacherRoutes.post(`/api/teacher/boards/:id/${path}`, async (c) => {
    const id = c.req.param("id");
    if (!(await getRegistry(c.env).getBoardRecord(id))) throw new HttpError(404, "not_found", "보드를 찾을 수 없어요.");
    unwrap(await getBoardStub(c.env, id).setArchived(archived));
    return c.json(await boardDetail(c.env, id), 200, noStore);
  });
}

teacherRoutes.delete("/api/teacher/boards/:id", async (c) => {
  const id = c.req.param("id");
  const rec = await getRegistry(c.env).deleteBoard(id);
  if (!rec) throw new HttpError(404, "not_found", "보드를 찾을 수 없어요.");
  await getBoardStub(c.env, id).destroy();
  return c.body(null, 204);
});

teacherRoutes.put("/api/teacher/boards/:id/class", async (c) => {
  const id = c.req.param("id");
  const body = await readJson(c);
  const classId = body.classId === null || body.classId === "" ? null : typeof body.classId === "string" ? body.classId : undefined;
  if (classId === undefined) throw new HttpError(400, "bad_request", "반을 골라 주세요.");
  const r = unwrap(await getRegistry(c.env).updateBoardMeta(id, { classId }));
  if (!r) throw new HttpError(404, "not_found", "보드를 찾을 수 없어요.");
  await syncBoardRoster(c.env, id);
  return c.json(await boardDetail(c.env, id), 200, noStore);
});

teacherRoutes.get("/api/teacher/recent-posts", async (c) => {
  const limit = Number(c.req.query("limit") ?? 12);
  const body: RecentPostsResponse = { posts: await getRegistry(c.env).recentPosts(Number.isFinite(limit) ? limit : 12) };
  return c.json(body, 200, noStore);
});

// ───── 반 ─────

teacherRoutes.get("/api/teacher/classes", async (c) => c.json({ classes: await getRegistry(c.env).listClasses() }, 200, noStore));

teacherRoutes.post("/api/teacher/classes", async (c) => {
  const body = await readJson(c);
  const students = body.students === undefined ? undefined : (body.students as StudentRowInput[]);
  const cls: ClassSummary = unwrap(await getRegistry(c.env).createClass(body.name, students));
  return c.json({ class: cls, students: (await getRegistry(c.env).listStudents(cls.id)) ?? [] }, 201, noStore);
});

teacherRoutes.patch("/api/teacher/classes/:id", async (c) => {
  const body = await readJson(c);
  return c.json({ class: unwrap(await getRegistry(c.env).renameClass(c.req.param("id"), body.name)) }, 200, noStore);
});

teacherRoutes.delete("/api/teacher/classes/:id", async (c) => {
  unwrap(await getRegistry(c.env).deleteClass(c.req.param("id")));
  return c.body(null, 204);
});

teacherRoutes.get("/api/teacher/classes/:id/students", async (c) => {
  const list = await getRegistry(c.env).listStudents(c.req.param("id"));
  if (!list) throw new HttpError(404, "not_found", "반을 찾을 수 없어요.");
  return c.json({ students: list }, 200, noStore);
});

teacherRoutes.post("/api/teacher/classes/:id/students", async (c) => {
  const classId = c.req.param("id");
  const body = await readJson(c);
  const added = unwrap(await getRegistry(c.env).addStudents(classId, body.students as StudentRowInput[]));
  await syncClassRoster(c.env, classId);
  return c.json({ added } satisfies AddStudentsResponse, 201, noStore);
});

// ───── 학생 ─────

async function afterStudentChange(env: Env, s: TeacherStudent): Promise<void> {
  await syncClassRoster(env, s.classId);
}

teacherRoutes.patch("/api/teacher/students/:id", async (c) => {
  const body = await readJson(c);
  const s = unwrap(await getRegistry(c.env).updateStudent(c.req.param("id"), body));
  await afterStudentChange(c.env, s);
  return c.json({ student: s }, 200, noStore);
});

teacherRoutes.delete("/api/teacher/students/:id", async (c) => {
  const r = unwrap(await getRegistry(c.env).deleteStudent(c.req.param("id")));
  await syncClassRoster(c.env, r.classId);
  return c.body(null, 204);
});

teacherRoutes.post("/api/teacher/students/:id/reset-pin", async (c) => {
  const s = unwrap(await getRegistry(c.env).resetStudentPin(c.req.param("id")));
  await afterStudentChange(c.env, s);
  return c.json({ student: s } satisfies ResetPinResponse, 200, noStore);
});

teacherRoutes.post("/api/teacher/students/:id/unlock", async (c) => {
  return c.json({ student: unwrap(await getRegistry(c.env).unlockStudent(c.req.param("id"))) }, 200, noStore);
});

teacherRoutes.get("/api/teacher/students/:id/portfolio", async (c) => {
  const t = await getRegistry(c.env).portfolioTargets(c.req.param("id"));
  if (!t) throw new HttpError(404, "not_found", "학생을 찾을 수 없어요.");
  const secret = await getSigningSecret(c.env);
  const boards = await Promise.all(
    t.boards.map(async (b) => ({
      id: b.id,
      code: b.code,
      title: b.title,
      archived: b.archived,
      posts: await getBoardStub(c.env, b.id).portfolioFor(t.student.ref),
      // 포트폴리오 화면에서 첨부 그림을 보여 주기 위한 파일 보기 토큰 (스냅숏과 같은 모양, 12시간)
      fileToken: await signToken(secret, FILE_VIEW_TOKEN_PURPOSE, { boardId: b.id } satisfies FileViewTokenPayload, 12 * 60 * 60),
    })),
  );
  const body: PortfolioResponse = { student: t.student, boards: boards.filter((b) => b.posts.length > 0) };
  return c.json(body, 200, noStore);
});
