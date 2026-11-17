/**
 * 나눔보드 실시간 프로토콜 + 보드/명단 REST 타입. 서버·프런트 공용 단일 출처 (DESIGN §6).
 * 설명은 docs/PROTOCOL.md.
 *
 * 규칙
 * - 모든 메시지는 JSON 텍스트 한 개. 필드 `t` 가 종류.
 * - 연결 유지: 클라이언트는 문자열 "ping" 을 보내면 서버가 "pong" 을 돌려준다 (Durable Object 를 깨우지 않는 자동 응답).
 * - 쓰기 메시지는 클라이언트가 만든 `opId`(8~64자 [A-Za-z0-9_-])를 붙인다. 서버는 반드시 같은 opId 로 `ack` 또는 `error` 를 보낸다.
 *   같은 opId 를 다시 보내도(재접속 후 재전송) 두 번 적용되지 않는다.
 * - 가시성 규칙은 서버가 적용한다. 클라이언트가 받는 값은 이미 역할별로 걸러져 있다.
 */

// ───────────────────────── 공통 값 ─────────────────────────

/** 보드 유형: 학생당 카드 1장(단일 주제) | 여러 장(누적) */
export type BoardType = "single" | "cumulative";
/** 열 구성: 개인별 | 모둠별 | 주제별 */
export type ColumnMode = "student" | "group" | "topic";
/** 입장 방식: 명단(학번+PIN) | 자유(닉네임) */
export type EntryMode = "roster" | "free";
export type Role = "teacher" | "student";
export type PostStatus = "visible" | "pending" | "hidden";
export type AttachmentKind = "image" | "file";

/** 서버가 강제하는 길이·개수 상한. 프런트도 같은 값으로 미리 막는다. */
export const LIMITS = {
  boardTitle: 100,
  boardDescription: 4000,
  postTitle: 100,
  postBody: 5000,
  postLink: 2000,
  attachmentsPerPost: 5,
  postsPerBoard: 3000,
  commentBody: 1000,
  commentsPerPost: 300,
  feedbackBody: 3000,
  noticeTitle: 100,
  noticeBody: 5000,
  noticesPerBoard: 50,
  columnTitle: 60,
  columnsPerBoard: 30,
  nickname: 20,
  studentName: 60,
  studentNumber: 20,
  groupName: 40,
  className: 60,
  studentsPerClass: 500,
  freeMembersPerBoard: 300,
  /** 웹소켓 메시지 한 개 최대 바이트 (UTF-8) */
  messageBytes: 64 * 1024,
  /** 첨부 파일 상한 (MB) 설정 범위 */
  maxFileMBMin: 1,
  maxFileMBMax: 100,
  maxFileMBDefault: 25,
} as const;

/** 웹소켓 종료 코드 (서버가 닫을 때) */
export const CLOSE_CODES = {
  /** 토큰이 더 이상 유효하지 않음 (PIN 초기화, 명단에서 빠짐, 입장 방식 변경). 다시 입장해야 함. 재접속 금지. */
  reauth: 4001,
  /** 보드가 보관됨 (학생). 재접속 금지. */
  archived: 4003,
  /** 보드가 삭제됨. 재접속 금지. */
  deleted: 4004,
  /** 메시지 남용(속도 제한 반복 위반). 잠시 뒤 재접속 가능. */
  abuse: 4008,
} as const;

/** 재접속하지 말아야 하는 종료 코드인지 */
export function isTerminalClose(code: number): boolean {
  return code === CLOSE_CODES.reauth || code === CLOSE_CODES.archived || code === CLOSE_CODES.deleted;
}

/** 오류 코드 (WS error.code, REST error.code 공용) */
export type ErrorCode =
  | "bad_request" // 형식이 잘못된 요청/메시지
  | "too_large" // 메시지·값이 너무 큼
  | "rate_limited" // 너무 빠름. retryAfterMs 참고
  | "unauthorized" // 로그인/입장 필요, 토큰 무효
  | "forbidden" // 권한 없음 (남의 글 수정 등)
  | "not_found" // 대상 없음
  | "locked" // 보드 잠김 (학생 쓰기 불가)
  | "archived" // 보관된 보드
  | "one_card_only" // 단일 주제 보드에서 두 번째 카드
  | "comments_disabled"
  | "likes_disabled"
  | "limit_reached" // 개수 상한
  | "column_required" // 주제별 열인데 열을 안 고름
  | "column_not_empty" // 카드가 있는 열 삭제 시도
  | "invalid_upload" // 업로드 확인 토큰이 무효/다른 보드/다른 사람
  | "invalid_settings" // 설정 조합 불가 (예: 자유 입장 + 모둠별)
  | "empty_post" // 제목·내용·링크·첨부 모두 없음
  | "invalid_credentials" // 학번 또는 PIN 틀림
  | "student_locked" // 5회 실패로 잠김. retryAfterMs
  | "too_many_attempts" // IP 당 시도 제한. retryAfterMs
  | "invalid_pin" // 새 PIN 규칙 위반
  | "wrong_entry_mode" // 이 보드의 입장 방식이 아님
  | "duplicate" // 학번 중복 등
  | "class_in_use" // 보드에 연결된 반 삭제 시도
  | "drive_unavailable"
  | "internal";

// ───────────────────────── 엔티티 (서버 → 클라이언트 보기) ─────────────────────────

/** 보드 설정 (모든 접속자에게 같은 값). */
export interface BoardSettings {
  title: string;
  /** 안내문 */
  description: string;
  type: BoardType;
  columnMode: ColumnMode;
  entryMode: EntryMode;
  /** 승인 후 게시: 학생 카드는 pending 으로 들어가고 교사가 승인해야 모두에게 보임 */
  moderation: boolean;
  /** 잠금: 학생은 아무것도 쓸 수 없음 (읽기만) */
  locked: boolean;
  /** 익명 모드: 학생에게 다른 학생의 이름·학번을 보내지 않음 */
  anonymous: boolean;
  allowComments: boolean;
  allowLikes: boolean;
  /** 첨부 파일 1개 최대 크기(MB) */
  maxFileMB: number;
  /** 보관됨 (교사만 접속 가능). settings.update 로는 못 바꿈 — REST archive/unarchive 사용 */
  archived: boolean;
}

/** settings.update / PATCH 로 바꿀 수 있는 필드 */
export type BoardSettingsPatch = Partial<Omit<BoardSettings, "archived">>;

export interface ColumnView {
  /**
   * 열 id.
   * - 주제별: 서버가 만든 id (column.save 로 생성)
   * - 개인별: "s:{ref}" (익명 모드의 학생 화면에서는 "s:{별칭}")
   * - 모둠별: "g:{모둠 이름}"
   * - 개인별·모둠별의 교사 카드 열: "teacher"
   */
  id: string;
  title: string;
  kind: "topic" | "student" | "group" | "teacher";
  /** 개인별 열의 주인 ref (익명이면 별칭) */
  ownerRef?: string;
  /** 내 열 (개인별: 내 열, 모둠별: 내 모둠) */
  mine?: boolean;
  position: number;
}

export interface AttachmentView {
  id: string;
  name: string;
  mime: string;
  size: number;
  kind: AttachmentKind;
  width?: number;
  height?: number;
  /** 파일 보기 주소 = `/api/files/{boardId}/{id}?t={snapshot.fileToken}` */
}

export interface CommentView {
  id: string;
  postId: string;
  /** 작성자 ref. 익명 모드의 학생 화면에서 다른 학생은 "a:{별칭}". 교사는 "teacher". */
  authorRef: string;
  /** 표시 이름. 익명 모드의 학생 화면에서 다른 학생은 "익명". */
  authorName: string;
  /** 교사 화면에만: 학번 */
  authorNumber?: string;
  mine: boolean;
  body: string;
  createdAt: number;
}

export interface FeedbackView {
  body: string;
  updatedAt: number;
}

export interface PostView {
  id: string;
  /** 놓일 열 id (ColumnView.id). 주제별에서 열이 없으면 null */
  columnId: string | null;
  authorRef: string;
  authorName: string;
  /** 학번: 교사, 본인, 그리고 익명이 아닌 보드의 명단 학생에게만 */
  authorNumber?: string;
  mine: boolean;
  title: string;
  body: string;
  link: string;
  /** 다른 학생에게는 항상 "visible" (그 외 상태 카드는 아예 안 보냄) */
  status: PostStatus;
  createdAt: number;
  updatedAt: number;
  attachments: AttachmentView[];
  comments: CommentView[];
  likeCount: number;
  likedByMe: boolean;
  /** 교사 피드백: 작성자 본인과 교사에게만. 없으면 생략 */
  feedback?: FeedbackView;
}

export interface NoticeView {
  id: string;
  title: string;
  body: string;
  createdAt: number;
  updatedAt: number;
}

/** 교사가 보는 보드 구성원 (명단 학생 + 자유 입장 학생) */
export interface MemberView {
  ref: string;
  kind: "roster" | "free";
  /** 학번 (명단) */
  number?: string;
  /** 실명 (명단) 또는 닉네임 (자유) */
  name: string;
  nickname: string;
  group: string;
}

/** 학생이 보는 다른 학생 (익명 모드에서는 목록 자체를 안 보냄) */
export interface PublicMemberView {
  ref: string;
  /** 닉네임이 있으면 닉네임, 없으면 이름 */
  name: string;
  number?: string;
  group: string;
}

export interface MeView {
  role: Role;
  /** "teacher" | "s:{학생id}" (명단) | "f:{기기 해시}" (자유) */
  ref: string;
  /** 화면 표시 이름 (닉네임 > 이름). 교사는 "선생님" */
  name: string;
  /** 본인 실명 (명단 학생) */
  realName?: string;
  number?: string;
  nickname?: string;
  group?: string;
}

export type BackupState = "never" | "pending" | "ok" | "error" | "unavailable";

/** 백업 상태 (교사에게만) */
export interface BackupInfo {
  state: BackupState;
  /** 마지막 성공 시각 */
  lastSuccessAt: number | null;
  /** 마지막 시도 시각 */
  lastAttemptAt: number | null;
  /** 연속 실패 횟수 */
  failures: number;
  /** 마지막 오류 (한국어 요약) */
  lastError: string | null;
  /** 마지막 오류 종류 (예: "api_disabled" → 설치 안내의 Drive API 도움말로 안내) */
  lastErrorCode?: string | null;
  /** 다음 시도 예정 시각 */
  nextAttemptAt: number | null;
}

export interface PresenceInfo {
  /** 지금 열려 있는 연결 수 (교사 포함) */
  count: number;
  /** 교사에게만: 접속 중인 ref 목록 (중복 제거) */
  online?: string[];
}

export interface BoardSnapshot {
  board: { id: string; code: string };
  settings: BoardSettings;
  me: MeView;
  columns: ColumnView[];
  /** 생성 순서(오래된 것 먼저) */
  posts: PostView[];
  /** 최신 먼저 */
  notices: NoticeView[];
  /** 학생 화면(익명 아님)에서만 */
  members?: PublicMemberView[];
  /** 교사 화면에서만 */
  roster?: MemberView[];
  /** 교사 화면, 명단 모드에서만: 아직 카드가 없는 학생 ref */
  notSubmitted?: string[];
  /** 교사 화면에서만 */
  backup?: BackupInfo;
  presence: PresenceInfo;
  /** 파일 보기 토큰 (12시간). `/api/files/{boardId}/{attachmentId}?t=` */
  fileToken: string;
  fileTokenExpiresAt: number;
  serverTime: number;
}

// ───────────────────────── 클라이언트 → 서버 ─────────────────────────

/** post.save 의 첨부 목록 항목: 기존 첨부 유지 | 새 업로드 확인 토큰 */
export type AttachmentRef = { id: string } | { uploadToken: string };

export interface PostInput {
  /** 있으면 수정, 없으면 새 카드 */
  id?: string;
  /** 주제별 열에서만 필요 (새 카드는 필수, 수정 시 주면 열 이동) */
  columnId?: string;
  title?: string;
  body?: string;
  link?: string;
  /** 최종 첨부 목록(순서 포함). 수정 시 생략하면 기존 첨부 유지. 최대 5개 */
  attachments?: AttachmentRef[];
  /** 교사 전용(명단 모드): 이 학생 이름으로 카드 작성 */
  onBehalfOf?: string;
}

export interface NoticeInput {
  id?: string;
  title: string;
  body: string;
}

export interface ColumnInput {
  id?: string;
  title: string;
}

interface Op {
  /** 클라이언트가 만든 작업 id. 8~64자 [A-Za-z0-9_-]. 새 항목 생성 시 멱등키로도 쓰인다. */
  opId: string;
}

export type ClientMessage =
  | ({ t: "post.save"; post: PostInput } & Op)
  | ({ t: "post.delete"; postId: string } & Op)
  /** 교사: approve(pending→visible) | hide(→hidden) | unhide(hidden→visible) */
  | ({ t: "post.moderate"; postId: string; action: "approve" | "hide" | "unhide" } & Op)
  | ({ t: "comment.add"; postId: string; body: string } & Op)
  | ({ t: "comment.delete"; postId: string; commentId: string } & Op)
  /** 좋아요는 토글이 아니라 원하는 상태를 보낸다 (멱등) */
  | ({ t: "like.set"; postId: string; liked: boolean } & Op)
  /** 교사: 빈 문자열이면 피드백 삭제 */
  | ({ t: "feedback.set"; postId: string; body: string } & Op)
  | ({ t: "notice.save"; notice: NoticeInput } & Op)
  | ({ t: "notice.delete"; noticeId: string } & Op)
  | ({ t: "settings.update"; patch: BoardSettingsPatch } & Op)
  | ({ t: "column.save"; column: ColumnInput } & Op)
  | ({ t: "column.delete"; columnId: string } & Op)
  /** 교사: 주제별 열 순서 (전체 id 목록) */
  | ({ t: "column.reorder"; order: string[] } & Op)
  /** 스냅숏 다시 받기 (opId 불필요) */
  | { t: "sync" };

export type ClientMessageType = ClientMessage["t"];

// ───────────────────────── 서버 → 클라이언트 ─────────────────────────

/** ack.result: 작업별 결과 */
export interface AckResult {
  postId?: string;
  commentId?: string;
  noticeId?: string;
  columnId?: string;
  /** 같은 opId 재전송이라 이미 처리된 결과를 돌려줌 */
  duplicate?: boolean;
}

export type ServerMessage =
  | { t: "snapshot"; snapshot: BoardSnapshot }
  | { t: "ack"; opId: string; result: AckResult }
  | { t: "error"; opId?: string; code: ErrorCode; message: string; retryAfterMs?: number }
  | { t: "post.upsert"; post: PostView }
  | { t: "post.remove"; postId: string }
  | { t: "comment.add"; comment: CommentView }
  | { t: "comment.remove"; postId: string; commentId: string }
  /** liked 는 받는 사람 본인 기준 */
  | { t: "like.set"; postId: string; count: number; liked: boolean }
  | { t: "notice.upsert"; notice: NoticeView }
  | { t: "notice.remove"; noticeId: string }
  | { t: "settings.update"; settings: BoardSettings }
  | { t: "columns.set"; columns: ColumnView[] }
  | { t: "presence"; presence: PresenceInfo }
  /** 교사에게만 */
  | { t: "submission"; notSubmitted: string[] }
  /** 교사에게만 */
  | { t: "backup.status"; backup: BackupInfo };

export type ServerMessageType = ServerMessage["t"];

// ───────────────────────── REST: 학생 입장 ─────────────────────────

/** GET /api/boards/:code — 누구나. 민감 정보 없음 */
export interface BoardPublicInfo {
  code: string;
  title: string;
  entryMode: EntryMode;
  locked: boolean;
  archived: boolean;
}

export interface StudentInfo {
  ref: string;
  /** 표시 이름 (닉네임 > 이름) */
  name: string;
  realName?: string;
  number?: string;
  nickname: string;
  group?: string;
}

/** POST /api/boards/:code/login (명단 모드) */
export interface LoginRequest {
  number: string;
  pin: string;
}
export type LoginResponse =
  | { status: "ok"; token: string; student: StudentInfo }
  /** 처음 입장: 초기 PIN 이 맞음 → 나만의 PIN 을 정해야 함 (POST /pin) */
  | { status: "pin_setup"; setupToken: string; student: StudentInfo };

/** POST /api/boards/:code/pin */
export interface SetPinRequest {
  setupToken: string;
  newPin: string;
}
export interface TokenResponse {
  token: string;
  student: StudentInfo;
}

/** POST /api/boards/:code/join (자유 입장). deviceToken 은 기기에서 만든 무작위 문자열(16~128자), localStorage 보관 */
export interface JoinRequest {
  nickname: string;
  deviceToken: string;
}

/** POST /api/boards/:code/nickname (Authorization: Bearer 학생 토큰). 자유 입장이면 새 토큰도 준다 */
export interface NicknameRequest {
  nickname: string;
}

/** GET /api/boards/:code/me (Bearer) → TokenResponse 에서 token 없는 모양 */
export interface StudentMeResponse {
  student: StudentInfo;
}

// ───────────────────────── REST: 교사 관리 ─────────────────────────

export interface BoardSummary {
  id: string;
  code: string;
  title: string;
  type: BoardType;
  columnMode: ColumnMode;
  entryMode: EntryMode;
  locked: boolean;
  archived: boolean;
  classId: string | null;
  className: string | null;
  createdAt: number;
  updatedAt: number;
  /** 최대 30초 정도 늦게 반영 */
  postCount: number;
  lastPostAt: number | null;
}

/** GET /api/teacher/boards/:id */
export interface BoardDetail extends BoardSummary {
  settings: BoardSettings;
  backup: BackupInfo;
}

/** POST /api/teacher/boards */
export interface CreateBoardRequest extends Partial<Omit<BoardSettings, "archived" | "title">> {
  title: string;
  classId?: string | null;
}

/** PATCH /api/teacher/boards/:id — BoardSettingsPatch 와 같음 */
export type UpdateBoardRequest = BoardSettingsPatch;

/** PUT /api/teacher/boards/:id/class */
export interface LinkClassRequest {
  classId: string | null;
}

export interface ClassSummary {
  id: string;
  name: string;
  studentCount: number;
  boardCount: number;
  createdAt: number;
}

/** 교사가 보는 명단 학생 */
export interface TeacherStudent {
  id: string;
  classId: string;
  /** 보드 안에서의 ref = "s:{id}" */
  ref: string;
  number: string;
  name: string;
  nickname: string;
  group: string;
  /** 학생이 나만의 PIN 을 정했는지 */
  pinRegistered: boolean;
  /** 아직 등록 전이면 초기 PIN (PIN 쪽지 인쇄용). 등록 후에는 null (서버도 모름) */
  initialPin: string | null;
  /** 5회 실패 잠금 해제 시각 (지금보다 미래면 잠김) */
  lockedUntil: number | null;
}

/** 명단 CSV 한 줄을 파싱한 값 (학번,이름,PIN,모둠,닉네임). PIN 이 비면 서버가 무작위 4자리 초기 PIN 을 만든다 */
export interface StudentRowInput {
  number: string;
  name: string;
  pin?: string;
  group?: string;
  nickname?: string;
}

/** POST /api/teacher/classes */
export interface CreateClassRequest {
  name: string;
  students?: StudentRowInput[];
}

/** POST /api/teacher/classes/:id/students */
export interface AddStudentsRequest {
  students: StudentRowInput[];
}
export interface AddStudentsResponse {
  added: TeacherStudent[];
}

/** PATCH /api/teacher/students/:id */
export interface UpdateStudentRequest {
  number?: string;
  name?: string;
  group?: string;
  nickname?: string;
}

/** POST /api/teacher/students/:id/reset-pin */
export interface ResetPinResponse {
  student: TeacherStudent;
}

/** GET /api/teacher/students/:id/portfolio */
export interface PortfolioResponse {
  student: TeacherStudent;
  boards: Array<{ id: string; code: string; title: string; archived: boolean; posts: PostView[]; /** 파일 보기 토큰 (12시간): `/api/files/{id}/{attachment.id}?t={fileToken}` */ fileToken?: string }>;
}

/** GET /api/teacher/recent-posts?limit= */
export interface RecentPost {
  boardId: string;
  boardCode: string;
  boardTitle: string;
  postId: string;
  authorName: string;
  authorNumber?: string;
  title: string;
  /** 본문 앞부분 (최대 200자) */
  excerpt: string;
  status: PostStatus;
  hasImage: boolean;
  /** 첫 사진 (대시보드 미리보기). 주소: /api/files/{boardId}/{image.id}?t={fileToken} */
  image?: { id: string; width?: number; height?: number };
  /** 이 보드의 파일 보기 토큰 (image 가 있을 때만, 12시간) */
  fileToken?: string;
  createdAt: number;
}
export interface RecentPostsResponse {
  posts: RecentPost[];
}

// ───────────────────────── 작은 공용 도구 ─────────────────────────

export const OP_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * 입장코드.
 * - 새 보드: 숫자 4자리 (예: 4821, 앞자리 0도 그대로 문자열). 한 설치 안에서 붐비면 5·6자리.
 * - 예전 보드: 영숫자 6자 (헷갈리는 0 O 1 I L 제외, 예: K7QX2M). 계속 쓸 수 있다.
 */
export const BOARD_CODE_DIGITS = 4;
export const BOARD_CODE_MAX_DIGITS = 6;
export const LEGACY_BOARD_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const LEGACY_BOARD_CODE_LENGTH = 6;
const NUMERIC_CODE_RE = /^[0-9]{4,6}$/;

/** 사용자가 친 입장코드 정리 (전각 글자 → 보통 글자, 공백·- 제거, 대문자) */
export function normalizeBoardCode(input: string): string {
  return input.normalize("NFKC").replace(/[\s-]/g, "").toUpperCase();
}

/** 숫자 4~6자리(새 보드) 또는 영숫자 6자(예전 보드) */
export function isValidBoardCode(code: string): boolean {
  if (NUMERIC_CODE_RE.test(code)) return true;
  if (code.length !== LEGACY_BOARD_CODE_LENGTH) return false;
  for (const ch of code) if (!LEGACY_BOARD_CODE_ALPHABET.includes(ch)) return false;
  return true;
}

/** 화면에 보일 입장코드: 4·5자리는 그대로("4821"), 6자는 3자씩 띄움("K7Q X2M") */
export function formatBoardCode(code: string): string {
  return code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code;
}
