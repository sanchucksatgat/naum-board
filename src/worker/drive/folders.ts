/**
 * 보드 폴더 구조 (§7):
 *   나눔보드/                      ← Registry.drive_root_id
 *     {보드 제목} ({코드})/         ← Board.getDriveState().folderId
 *       첨부/                      ← attachFolderId
 *       게시글 백업.json            ← backupFileId
 *       {보드 제목} 내보내기 ….    ← 시트 내보내기
 *
 * 교사가 드라이브에서 폴더를 지우거나 휴지통에 넣으면 다음 사용 때 다시 만든다.
 * (Drive 의 trashed 는 "직접 또는 상위 폴더가 휴지통에 들어감"을 뜻하므로 가장 깊은 폴더 하나만 확인하면 된다.)
 * 폴더에는 appProperties 표시를 달아 두어, 저장된 id 를 잃어버려도 이 앱이 만든 폴더를 다시 찾는다.
 */
import type { Env } from "../env";
import { getRegistry } from "../stubs";
import { createFolder, FOLDER_MIME, getFile, listFiles, q, updateMedia, updateMetadata, uploadMultipart } from "./client";
import { getDriveDeps, type BoardDriveRpc, type DriveState, type DriveStatePatch } from "./deps";

export const ROOT_FOLDER_NAME = "나눔보드";
export const ATTACH_FOLDER_NAME = "첨부";
export const BACKUP_FILE_NAME = "게시글 백업.json";
const MAX_FOLDER_TITLE = 80;

/** 확인한 폴더 id 를 isolate 에 잠깐 기억해 매번 Drive 를 부르지 않는다. */
const VERIFY_TTL_MS = 5 * 60_000;
const verified = new Map<string, number>();
let rootCache: { id: string; at: number } | null = null;
const inflight = new Map<string, Promise<{ folderId: string; attachFolderId: string }>>();

/** 테스트용 */
export function resetDriveFolderCache(): void {
  verified.clear();
  rootCache = null;
  inflight.clear();
}

function markAlive(id: string): void {
  if (verified.size > 500) verified.clear();
  verified.set(id, Date.now());
}

function forget(id: string | null | undefined): void {
  if (id) verified.delete(id);
  if (id && rootCache?.id === id) rootCache = null;
}

/** 폴더가 존재하고 휴지통에 없는가 */
async function alive(env: Env, id: string | null | undefined): Promise<boolean> {
  if (!id) return false;
  const at = verified.get(id);
  if (at && Date.now() - at < VERIFY_TTL_MS) return true;
  const f = await getFile(env, id, "id,trashed,mimeType");
  if (!f || f.trashed || (f.mimeType && f.mimeType !== FOLDER_MIME)) {
    forget(id);
    return false;
  }
  markAlive(id);
  return true;
}

export function boardFolderName(title: string, code: string): string {
  const clean = title.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim() || "제목 없는 보드";
  const t = clean.length > MAX_FOLDER_TITLE ? clean.slice(0, MAX_FOLDER_TITLE) + "…" : clean;
  return `${t} (${code})`;
}

/** 최상위 "나눔보드" 폴더 id (없거나 지워졌으면 만든다) */
export async function ensureRootFolder(env: Env): Promise<string> {
  if (rootCache && Date.now() - rootCache.at < VERIFY_TTL_MS) return rootCache.id;
  const reg = getRegistry(env);
  const stored = await reg.getDriveRootId();
  if (stored && (await alive(env, stored))) {
    rootCache = { id: stored, at: Date.now() };
    return stored;
  }
  const found = await listFiles(
    env,
    `appProperties has { key='nanumboard' and value='root' } and mimeType=${q(FOLDER_MIME)} and trashed=false`,
  );
  const id = found[0]?.id ?? (await createFolder(env, ROOT_FOLDER_NAME, null, { nanumboard: "root" })).id;
  await reg.setDriveRootId(id);
  markAlive(id);
  rootCache = { id, at: Date.now() };
  return id;
}

export interface DriveOpts {
  /** Board DO 안에서 부를 때: 자기 상태를 직접 넘기면 자기 자신에게 RPC 하지 않는다 */
  state?: DriveState;
  /** Board DO 안에서 부를 때: setDriveState 대신 쓸 함수 등 (기본은 Board DO stub) */
  board?: BoardDriveRpc;
}

function boardOf(env: Env, boardId: string, opts?: DriveOpts): BoardDriveRpc {
  return opts?.board ?? getDriveDeps().board(env, boardId);
}

/**
 * §10: 보드 폴더와 첨부 폴더를 보장한다. Board 의 get/setDriveState 를 쓴다.
 * 같은 isolate 에서 동시에 불리면 한 번만 만든다.
 */
export function ensureBoardFolders(env: Env, boardId: string, opts?: DriveOpts): Promise<{ folderId: string; attachFolderId: string }> {
  const running = inflight.get(boardId);
  if (running) return running;
  const p = doEnsure(env, boardId, opts).finally(() => inflight.delete(boardId));
  inflight.set(boardId, p);
  return p;
}

async function doEnsure(env: Env, boardId: string, opts?: DriveOpts): Promise<{ folderId: string; attachFolderId: string }> {
  const board = boardOf(env, boardId, opts);
  const state = opts?.state ?? (await board.getDriveState());

  // 첨부 폴더가 살아 있으면 상위 폴더도 살아 있다 (휴지통은 하위로 전파).
  if (state.folderId && state.attachFolderId && (await alive(env, state.attachFolderId))) {
    return { folderId: state.folderId, attachFolderId: state.attachFolderId };
  }

  const patch: DriveStatePatch = {};
  let folderId = state.folderId ?? null;
  if (!(await alive(env, folderId))) {
    const rootId = await ensureRootFolder(env);
    const found = await listFiles(
      env,
      `appProperties has { key='nanumboardBoard' and value=${q(boardId)} } and mimeType=${q(FOLDER_MIME)} and trashed=false`,
    );
    folderId = found[0]?.id ?? (await createFolder(env, boardFolderName(state.title, state.code), rootId, { nanumboardBoard: boardId })).id;
    markAlive(folderId);
    patch.folderId = folderId;
    // 폴더가 바뀌면 그 안의 것들도 새로 찾는다
    patch.attachFolderId = null;
    if (folderId !== state.folderId) patch.backupFileId = null;
  }

  let attachFolderId = patch.attachFolderId === null ? null : (state.attachFolderId ?? null);
  if (!(await alive(env, attachFolderId))) {
    const found = await listFiles(
      env,
      `appProperties has { key='nanumboardAttach' and value=${q(boardId)} } and ${q(folderId!)} in parents and trashed=false`,
    );
    attachFolderId = found[0]?.id ?? (await createFolder(env, ATTACH_FOLDER_NAME, folderId, { nanumboardAttach: boardId })).id;
    markAlive(attachFolderId);
  }
  patch.attachFolderId = attachFolderId;

  await board.setDriveState(patch);
  return { folderId: folderId!, attachFolderId: attachFolderId! };
}

/**
 * §10: `게시글 백업.json` 생성/갱신. 실패하면 DriveError 를 던진다(재시도는 Board DO 알람 몫).
 * 성공하면 setDriveState({ backupFileId, lastBackupAt, backupError: null }).
 */
export async function writeBoardBackup(env: Env, boardId: string, content: object, opts?: DriveOpts): Promise<void> {
  const board = boardOf(env, boardId, opts);
  const state = opts?.state ?? (await board.getDriveState());
  const { folderId } = await ensureBoardFolders(env, boardId, { board, state });
  // ensure 가 폴더를 새로 만들었으면 예전 backupFileId 는 버린다(다른 폴더에 있음)
  const backupFileId = folderId === state.folderId ? state.backupFileId : null;
  const json = JSON.stringify(content);

  let id: string | null = null;
  if (backupFileId) {
    const updated = await updateMedia(env, backupFileId, json, "application/json; charset=utf-8", "id,trashed");
    if (updated && !updated.trashed) id = updated.id;
  }
  if (!id) {
    const created = await uploadMultipart(
      env,
      { name: BACKUP_FILE_NAME, mimeType: "application/json", parents: [folderId], appProperties: { nanumboardBackup: boardId } },
      json,
      "application/json; charset=utf-8",
    );
    id = created.id;
  }
  const patch: DriveStatePatch = { lastBackupAt: Date.now(), backupError: null };
  if (id !== state.backupFileId) patch.backupFileId = id;
  await board.setDriveState(patch);
}

/** §10: 보드 이름이 바뀌면 드라이브 폴더 이름도 바꾼다. 폴더가 아직 없거나 지워졌으면 아무 일도 안 함(다음에 새 이름으로 만든다). */
export async function renameBoardFolder(env: Env, boardId: string, title: string, opts?: DriveOpts): Promise<void> {
  const state = opts?.state ?? (await boardOf(env, boardId, opts).getDriveState());
  if (!state.folderId) return;
  const r = await updateMetadata(env, state.folderId, { name: boardFolderName(title, state.code) });
  if (!r) forget(state.folderId);
}
