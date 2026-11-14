/** 시트 내보내기와 드라이브 상태 (교사 전용). */
import type { Env } from "../env";
import { HttpError } from "../http";
import type { BackupStatus, BoardDriveResponse, ExportResponse } from "../../shared/files";
import { folderUrl, SHEET_MIME, sheetUrl, uploadMultipart } from "./client";
import { DriveError } from "./errors";
import { getDriveDeps, type BoardRef } from "./deps";
import { ensureBoardFolders } from "./folders";

/** 시트가 수식으로 해석하지 않게: (앞 공백·줄바꿈 뒤라도) =,+,-,@ 나 탭·CR·LF 로 시작하면 앞에 ' 를 붙인다 (CSV 주입 방지) */
function cell(v: unknown): string {
  let s = v === null || v === undefined ? "" : String(v);
  if (/^[\s]*[=+\-@]/.test(s) || /^[\t\r\n]/.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export { cell as csvCell };

export function toCsv(header: string[], rows: string[][]): string {
  return [header, ...rows].map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
}

async function resolveBoard(env: Env, code: string): Promise<BoardRef> {
  const b = await getDriveDeps().resolveBoardByCode(env, code);
  if (!b) throw new HttpError(404, "board_not_found", "보드를 찾을 수 없어요.");
  return b;
}

function stamp(now: Date): string {
  // 한국 시간 기준 YYYY-MM-DD HH:mm
  const k = new Date(now.getTime() + 9 * 3600_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${k.getUTCFullYear()}-${p(k.getUTCMonth() + 1)}-${p(k.getUTCDate())} ${p(k.getUTCHours())}:${p(k.getUTCMinutes())}`;
}

export async function exportBoard(env: Env, code: string): Promise<ExportResponse> {
  const b = await resolveBoard(env, code);
  const board = getDriveDeps().board(env, b.id);
  const { header, rows } = await board.exportRows();
  try {
    const { folderId } = await ensureBoardFolders(env, b.id);
    const f = await uploadMultipart(
      env,
      { name: `${b.title} 내보내기 ${stamp(new Date())}`, mimeType: SHEET_MIME, parents: [folderId] },
      toCsv(header, rows),
      "text/csv; charset=utf-8",
      "id,webViewLink",
    );
    return { url: f.webViewLink ?? sheetUrl(f.id) };
  } catch (e) {
    throw e instanceof DriveError ? e.toHttpError() : e;
  }
}

export async function boardDriveInfo(env: Env, code: string): Promise<BoardDriveResponse> {
  const b = await resolveBoard(env, code);
  const s = await getDriveDeps().board(env, b.id).getDriveState();
  let status: BackupStatus;
  if (s.backupError) status = "error";
  else if (s.backupPending) status = "pending";
  else if (s.lastBackupAt || s.backupFileId) status = "ok";
  else status = "never";
  const backup: BoardDriveResponse["backup"] = { status, lastAt: s.lastBackupAt ?? null };
  if (s.backupError) backup.error = s.backupError;
  return { folderUrl: s.folderId ? folderUrl(s.folderId) : null, backup };
}
