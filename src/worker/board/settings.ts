/** 보드 설정 기본값·검증 (Board DO, 보드 만들기 라우트 공용) */
import { LIMITS, type BoardSettings, type BoardSettingsPatch } from "../../shared/protocol";
import { bool, fail, intIn, isPlainObject, line, oneOf, text } from "./validate";

export const DEFAULT_SETTINGS: BoardSettings = {
  title: "",
  description: "",
  type: "cumulative",
  columnMode: "student",
  entryMode: "roster",
  moderation: false,
  locked: false,
  anonymous: false,
  allowComments: true,
  allowLikes: true,
  maxFileMB: LIMITS.maxFileMBDefault,
  archived: false,
};

/** 클라이언트가 보낸 설정 패치 검증. 모르는 키는 오류 (오타를 조용히 무시하지 않음). */
export function parseSettingsPatch(raw: unknown): BoardSettingsPatch {
  if (!isPlainObject(raw)) fail("bad_request", "설정 값이 올바르지 않아요.");
  const r = raw as Record<string, unknown>;
  const out: BoardSettingsPatch = {};
  for (const [k, v] of Object.entries(r)) {
    if (v === undefined) continue;
    switch (k) {
      case "title":
        out.title = line(v, LIMITS.boardTitle, "보드 제목", true);
        break;
      case "description":
        out.description = text(v, LIMITS.boardDescription, "안내문");
        break;
      case "type":
        out.type = oneOf(v, ["single", "cumulative"] as const, "보드 유형");
        break;
      case "columnMode":
        out.columnMode = oneOf(v, ["student", "group", "topic"] as const, "열 구성");
        break;
      case "entryMode":
        out.entryMode = oneOf(v, ["roster", "free"] as const, "입장 방식");
        break;
      case "moderation":
      case "locked":
      case "anonymous":
      case "allowComments":
      case "allowLikes":
        out[k] = bool(v, k);
        break;
      case "maxFileMB":
        out.maxFileMB = intIn(v, LIMITS.maxFileMBMin, LIMITS.maxFileMBMax, "첨부 파일 최대 크기(MB)");
        break;
      default:
        fail("bad_request", `알 수 없는 설정이에요: ${k.slice(0, 40)}`);
    }
  }
  return out;
}

/** 조합 규칙 (멤버·카드 상태와 무관한 것만) */
export function checkSettingsCombination(s: BoardSettings): void {
  if (s.entryMode === "free" && s.columnMode === "group") {
    fail("invalid_settings", "자유 입장 보드는 모둠별 열을 쓸 수 없어요. 명단 입장으로 바꾸거나 다른 열 구성을 골라 주세요.");
  }
}

/** Registry 원본과 묶인 필드 */
export const MIRRORED_KEYS = ["title", "type", "columnMode", "entryMode", "locked"] as const;
