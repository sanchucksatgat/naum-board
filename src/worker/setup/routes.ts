/**
 * 설치 점검용 라우트 (태스크6). /setup 화면의 "설치 점검" 단계가 쓴다.
 * - GET /api/setup/drive-check (교사): 드라이브에 실제로 한 번 접근해서 Drive API 사용 설정 여부까지 확인.
 */
import { Hono } from "hono";
import type { SetupDriveCheck } from "../../shared/api";
import type { Env } from "../env";
import { requireTeacher } from "../auth";
import { DRIVE_API, driveFetch } from "../drive/client";
import { DriveError } from "../drive/errors";

export async function checkDriveAccess(env: Env): Promise<SetupDriveCheck> {
  try {
    // drive.file 범위에서도 허용되는 가장 가벼운 호출 (앱이 만든 파일 1개까지만 조회)
    await driveFetch(env, `${DRIVE_API}/files?pageSize=1&fields=files(id)&q=${encodeURIComponent("trashed = false")}`);
    return { ok: true };
  } catch (e) {
    if (!(e instanceof DriveError)) throw e;
    if (e.code === "api_disabled") {
      return { ok: false, code: "api_disabled", message: "Google Cloud 프로젝트에서 Google Drive API가 꺼져 있어요." };
    }
    const code: Exclude<SetupDriveCheck, { ok: true }>["code"] =
      e.code === "reconnect" || e.code === "storage_full" || e.code === "unavailable" || e.code === "not_configured" ? e.code : "other";
    return { ok: false, code, message: e.message };
  }
}

export const setupRoutes = new Hono<{ Bindings: Env }>();

setupRoutes.get("/api/setup/drive-check", async (c) => {
  await requireTeacher(c.req.raw, c.env);
  return c.json(await checkDriveAccess(c.env), 200, { "cache-control": "no-store" });
});
