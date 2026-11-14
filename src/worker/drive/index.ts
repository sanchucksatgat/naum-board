/** 태스크3 공개 API (docs/DESIGN.md §10). 다른 태스크는 여기서 가져다 쓴다. */
export { ensureBoardFolders, writeBoardBackup, renameBoardFolder, ensureRootFolder, boardFolderName, type DriveOpts } from "./folders";
export { driveRoutes } from "./routes";
export { DriveError, type DriveErrorCode } from "./errors";
export {
  setDriveDeps,
  type DriveDeps,
  type BoardActor,
  type BoardDriveRpc,
  type DriveState,
  type DriveStatePatch,
  type UploadPolicy,
  type AttachmentRecord,
  type BoardRef,
} from "./deps";
export { folderUrl } from "./client";
