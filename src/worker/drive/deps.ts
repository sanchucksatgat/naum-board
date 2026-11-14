/**
 * 태스크2(보드·Registry)에 기대는 부분을 한곳에 모은 주입 가능한 인터페이스.
 * 시그니처는 docs/DESIGN.md §10 그대로. 병렬 작업 중이라 아직 구현이 없을 수 있어
 * 타입은 여기서 구조적으로 정의하고, 실제 연결은 setDriveDeps 로 바꿀 수 있게 했다.
 *
 * 통합할 때(지휘관): index.ts 등에서
 *   import { authenticateBoardActor } from "./board/actor";
 *   setDriveDeps({ authenticateBoardActor });
 * 한 줄이면 된다. Board/Registry RPC 는 기본값이 이미 실제 DO stub 을 부른다.
 */
import type { Env } from "../env";
import { getTeacher } from "../auth";
import { getBoardStub, getRegistry } from "../stubs";

/** §10 BoardActor */
export interface BoardActor {
  role: "teacher" | "student";
  ref: string;
  name: string;
  boardId: string;
  code: string;
}

export type UploadPolicy = { ok: true; maxBytes: number } | { ok: false; reason: string };

export interface AttachmentRecord {
  driveFileId: string;
  name: string;
  mime: string;
  size: number;
  kind: "image" | "file";
}

/**
 * §10 getDriveState. 아래 백업 상태 필드(lastBackupAt 등)는 태스크3이 덧붙인 선택 필드:
 * writeBoardBackup 성공 시 lastBackupAt 을 patch 하고, Board DO 는 실패·재시도 상태를 backupError/backupPending 으로 남길 수 있다.
 */
export interface DriveState {
  folderId?: string | null;
  attachFolderId?: string | null;
  backupFileId?: string | null;
  title: string;
  code: string;
  lastBackupAt?: number | null;
  backupError?: string | null;
  backupPending?: boolean;
}

/** setDriveState 패치. null = 지움 */
export type DriveStatePatch = Partial<Omit<DriveState, "title" | "code">>;

export interface BoardDriveRpc {
  getUploadPolicy(actor: BoardActor): Promise<UploadPolicy> | UploadPolicy;
  getAttachment(attachmentId: string): Promise<AttachmentRecord | null> | AttachmentRecord | null;
  getDriveState(): Promise<DriveState> | DriveState;
  setDriveState(patch: DriveStatePatch): Promise<void> | void;
  exportRows(): Promise<{ header: string[]; rows: string[][] }> | { header: string[]; rows: string[][] };
}

export interface BoardRef {
  id: string;
  code: string;
  title: string;
  archived: boolean;
}

export interface DriveDeps {
  authenticateBoardActor(request: Request, env: Env, code: string): Promise<BoardActor | null>;
  resolveBoardByCode(env: Env, code: string): Promise<BoardRef | null>;
  board(env: Env, boardId: string): BoardDriveRpc;
}

const defaults: DriveDeps = {
  resolveBoardByCode: async (env, code) => {
    const reg = getRegistry(env) as unknown as { resolveBoardByCode(code: string): Promise<BoardRef | null> };
    return reg.resolveBoardByCode(code);
  },
  board: (env, boardId) => getBoardStub(env, boardId) as unknown as BoardDriveRpc,
  // 임시: 태스크2의 authenticateBoardActor 가 연결되기 전에는 교사(소유자)만 인식한다.
  authenticateBoardActor: async (request, env, code) => {
    const teacher = await getTeacher(request, env);
    if (!teacher) return null;
    const b = await deps.resolveBoardByCode(env, code);
    if (!b) return null;
    return { role: "teacher", ref: "teacher", name: "선생님", boardId: b.id, code: b.code };
  },
};

let deps: DriveDeps = { ...defaults };

export function getDriveDeps(): DriveDeps {
  return deps;
}

/** 일부만 바꾼다 (테스트 mock, 통합 시 실제 구현 연결) */
export function setDriveDeps(patch: Partial<DriveDeps>): void {
  deps = { ...deps, ...patch };
}

/** 기본값으로 되돌림 (테스트용) */
export function resetDriveDeps(): void {
  deps = { ...defaults };
}
