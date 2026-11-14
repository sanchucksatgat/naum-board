/** 교사 화면 REST 호출 (같은 출처, 쿠키). 오류는 서버의 한국어 message 를 그대로 보여 준다. */
import type {
  AddStudentsResponse, BoardDetail, BoardSettingsPatch, BoardSummary, ClassSummary, CreateBoardRequest, PortfolioResponse,
  RecentPostsResponse, StudentRowInput, TeacherStudent, UpdateStudentRequest,
} from "../../src/shared/protocol";
import type { BoardDriveResponse, ExportResponse } from "../../src/shared/files";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

const FALLBACK: Record<number, string> = {
  401: "로그인이 풀렸어요. 다시 로그인해 주세요.",
  403: "이 작업을 할 수 없어요.",
  404: "찾을 수 없어요. 이미 지워졌을 수 있어요.",
  409: "다른 내용과 겹쳐요. 확인 후 다시 해 주세요.",
  429: "너무 빨라요. 잠시 후 다시 해 주세요.",
};

/** 401 이 오면 화면이 로그인 상태를 다시 확인하도록 알림 */
export const AUTH_LOST_EVENT = "nb:teacher-auth-lost";

export async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: "same-origin",
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, "network", "인터넷 연결을 확인해 주세요. 연결되면 다시 시도해 주세요.");
  }
  if (res.status === 204) return undefined as T;
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    /* 본문 없음 */
  }
  if (!res.ok) {
    const err = (data as { error?: { code?: string; message?: string } } | null)?.error;
    if (res.status === 401) dispatchEvent(new Event(AUTH_LOST_EVENT));
    throw new ApiError(res.status, err?.code ?? "http_" + res.status, err?.message ?? FALLBACK[res.status] ?? "잠시 문제가 생겼어요. 다시 시도해 주세요.");
  }
  return data as T;
}

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error && e.message) return e.message;
  return "잠시 문제가 생겼어요. 다시 시도해 주세요.";
}

const enc = encodeURIComponent;

export const api = {
  boards: (archived: "0" | "1" | "all" = "0") => request<{ boards: BoardSummary[] }>("GET", `/api/teacher/boards?archived=${archived}`).then((r) => r.boards),
  board: (id: string) => request<BoardDetail>("GET", `/api/teacher/boards/${enc(id)}`),
  createBoard: (body: CreateBoardRequest) => request<BoardDetail>("POST", "/api/teacher/boards", body),
  updateBoard: (id: string, patch: BoardSettingsPatch) => request<BoardDetail>("PATCH", `/api/teacher/boards/${enc(id)}`, patch),
  archive: (id: string, archived: boolean) => request<BoardDetail>("POST", `/api/teacher/boards/${enc(id)}/${archived ? "archive" : "unarchive"}`),
  deleteBoard: (id: string) => request<void>("DELETE", `/api/teacher/boards/${enc(id)}`),
  linkClass: (id: string, classId: string | null) => request<BoardDetail>("PUT", `/api/teacher/boards/${enc(id)}/class`, { classId }),
  recentPosts: (limit = 12) => request<RecentPostsResponse>("GET", `/api/teacher/recent-posts?limit=${limit}`).then((r) => r.posts),

  classes: () => request<{ classes: ClassSummary[] }>("GET", "/api/teacher/classes").then((r) => r.classes),
  createClass: (name: string, students?: StudentRowInput[]) =>
    request<{ class: ClassSummary; students: TeacherStudent[] }>("POST", "/api/teacher/classes", students ? { name, students } : { name }),
  renameClass: (id: string, name: string) => request<{ class: ClassSummary }>("PATCH", `/api/teacher/classes/${enc(id)}`, { name }).then((r) => r.class),
  deleteClass: (id: string) => request<void>("DELETE", `/api/teacher/classes/${enc(id)}`),
  students: (classId: string) => request<{ students: TeacherStudent[] }>("GET", `/api/teacher/classes/${enc(classId)}/students`).then((r) => r.students),
  addStudents: (classId: string, students: StudentRowInput[]) =>
    request<AddStudentsResponse>("POST", `/api/teacher/classes/${enc(classId)}/students`, { students }).then((r) => r.added),
  updateStudent: (id: string, patch: UpdateStudentRequest) =>
    request<{ student: TeacherStudent }>("PATCH", `/api/teacher/students/${enc(id)}`, patch).then((r) => r.student),
  deleteStudent: (id: string) => request<void>("DELETE", `/api/teacher/students/${enc(id)}`),
  resetPin: (id: string) => request<{ student: TeacherStudent }>("POST", `/api/teacher/students/${enc(id)}/reset-pin`).then((r) => r.student),
  unlock: (id: string) => request<{ student: TeacherStudent }>("POST", `/api/teacher/students/${enc(id)}/unlock`).then((r) => r.student),
  portfolio: (id: string) => request<PortfolioResponse>("GET", `/api/teacher/students/${enc(id)}/portfolio`),

  drive: (code: string) => request<BoardDriveResponse>("GET", `/api/boards/${enc(code)}/drive`),
  exportSheet: (code: string) => request<ExportResponse>("POST", `/api/boards/${enc(code)}/export`),
  logout: () => request<void>("POST", "/auth/logout"),
};
