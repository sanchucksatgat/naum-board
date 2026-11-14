import { useEffect, useState } from "preact/hooks";

/**
 * 설치 안내 진행 상태. 이 브라우저(이 주소)의 localStorage 에만 저장한다.
 * 비밀번호류는 절대 넣지 않는다 (클라이언트 보안 비밀번호는 입력받지도 않음).
 */
export interface SetupState {
  step: string;
  done: Record<string, true>;
  account: "personal" | "school" | "";
  /** 선생님이 붙여 넣은 나눔보드 주소 (origin) */
  instanceUrl: string;
  clientId: string;
  ownerEmail: string;
}

const KEY = "nanumboard.setup.v1";

export const EMPTY_STATE: SetupState = { step: "start", done: {}, account: "", instanceUrl: "", clientId: "", ownerEmail: "" };

export function loadState(): SetupState {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...EMPTY_STATE };
    const v = JSON.parse(raw) as Partial<SetupState>;
    return {
      step: typeof v.step === "string" ? v.step : EMPTY_STATE.step,
      done: v.done && typeof v.done === "object" ? (v.done as Record<string, true>) : {},
      account: v.account === "personal" || v.account === "school" ? v.account : "",
      instanceUrl: typeof v.instanceUrl === "string" ? v.instanceUrl : "",
      clientId: typeof v.clientId === "string" ? v.clientId : "",
      ownerEmail: typeof v.ownerEmail === "string" ? v.ownerEmail : "",
    };
  } catch {
    return { ...EMPTY_STATE };
  }
}

export function hasSavedState(): boolean {
  try {
    return localStorage.getItem(KEY) !== null;
  } catch {
    return false;
  }
}

function saveState(s: SetupState): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* 사생활 보호 모드 등: 저장 없이도 동작 */
  }
}

export function clearState(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* 무시 */
  }
}

export function useSetupState() {
  const [state, setState] = useState<SetupState>(loadState);
  useEffect(() => saveState(state), [state]);
  const update = (patch: Partial<SetupState> | ((s: SetupState) => Partial<SetupState>)) =>
    setState((s) => ({ ...s, ...(typeof patch === "function" ? patch(s) : patch) }));
  return [state, update, setState] as const;
}
