/** 교사 화면 안에서만 쓰는 작은 부품 (공용화는 통합 단계에서). */
import type { ComponentChildren, JSX } from "preact";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { errorMessage } from "./api";

// ───────────── 토스트 ─────────────

type ToastItem = { id: number; text: string; tone: "info" | "error" };
let toastSeq = 0;
let toastItems: ToastItem[] = [];
const toastListeners = new Set<(items: ToastItem[]) => void>();

export function toast(text: string, tone: "info" | "error" = "info"): void {
  const item = { id: ++toastSeq, text, tone };
  toastItems = [...toastItems.slice(-2), item];
  toastListeners.forEach((l) => l(toastItems));
  setTimeout(() => {
    toastItems = toastItems.filter((t) => t.id !== item.id);
    toastListeners.forEach((l) => l(toastItems));
  }, tone === "error" ? 6000 : 3200);
}

export function Toasts() {
  const [items, setItems] = useState<ToastItem[]>(toastItems);
  useEffect(() => {
    toastListeners.add(setItems);
    return () => void toastListeners.delete(setItems);
  }, []);
  return (
    <div class="toast-area no-print" role="status" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} class={"toast" + (t.tone === "error" ? " t-toast-error" : "")}>
          {t.text}
        </div>
      ))}
    </div>
  );
}

// ───────────── 모달 ─────────────

const modalStack: string[] = [];
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Modal(props: {
  title: string;
  onClose: () => void;
  children: ComponentChildren;
  footer?: ComponentChildren;
  wide?: boolean;
  /** 저장 중에는 닫히지 않게 */
  busy?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useRef("m" + Math.random().toString(36).slice(2)).current;
  const { onClose, busy } = props;
  const latest = useRef({ onClose, busy });
  latest.current = { onClose, busy };
  // Esc 는 문서 전체에서 받는다 (포커스가 모달 밖으로 빠져도 닫히게). 겹친 모달은 맨 위 것만.
  useLayoutEffect(() => {
    modalStack.push(titleId);
    const onDocKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || modalStack[modalStack.length - 1] !== titleId || latest.current.busy) return;
      e.preventDefault();
      latest.current.onClose();
    };
    document.addEventListener("keydown", onDocKey);
    return () => {
      document.removeEventListener("keydown", onDocKey);
      const i = modalStack.lastIndexOf(titleId);
      if (i >= 0) modalStack.splice(i, 1);
    };
  }, [titleId]);
  useLayoutEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const el = ref.current;
    const first = el?.querySelector<HTMLElement>("[data-autofocus]") ?? el?.querySelector<HTMLElement>(FOCUSABLE);
    first?.focus();
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = "";
      prev?.focus?.();
    };
  }, []);
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Tab" && ref.current) {
      const list = [...ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((x) => x.offsetParent !== null);
      if (!list.length) return;
      const firstEl = list[0]!;
      const lastEl = list[list.length - 1]!;
      if (e.shiftKey && document.activeElement === firstEl) {
        e.preventDefault();
        lastEl.focus();
      } else if (!e.shiftKey && document.activeElement === lastEl) {
        e.preventDefault();
        firstEl.focus();
      }
    }
  };
  return (
    <div
      class="modal-backdrop no-print"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div ref={ref} class={"modal t-modal" + (props.wide ? " t-modal-wide" : "")} role="dialog" aria-modal="true" aria-labelledby={titleId} onKeyDown={onKey}>
        <div class="t-modal-head">
          <h2 id={titleId}>{props.title}</h2>
          <button type="button" class="btn btn-ghost btn-icon" aria-label="닫기" onClick={onClose} disabled={busy}>
            ✕
          </button>
        </div>
        <div class="t-modal-body">{props.children}</div>
        {props.footer && <div class="t-modal-foot">{props.footer}</div>}
      </div>
    </div>
  );
}

// ───────────── 불러오기 상태 ─────────────

export function Loading(props: { text?: string }) {
  return (
    <div class="t-state" role="status" aria-live="polite">
      <span class="t-spinner" aria-hidden="true" />
      <span>{props.text ?? "불러오는 중이에요…"}</span>
    </div>
  );
}

export function ErrorBox(props: { error: unknown; onRetry?: () => void }) {
  return (
    <div class="t-state t-state-error" role="alert">
      <p>{errorMessage(props.error)}</p>
      {props.onRetry && (
        <button type="button" class="btn btn-small" onClick={props.onRetry}>
          다시 시도
        </button>
      )}
    </div>
  );
}

export function Empty(props: { title: string; children?: ComponentChildren }) {
  return (
    <div class="t-empty">
      <p class="t-empty-title">{props.title}</p>
      {props.children}
    </div>
  );
}

export type Async<T> = { status: "loading" } | { status: "error"; error: unknown } | { status: "ok"; data: T };

/** 불러오기 + 다시 불러오기. deps 가 바뀌면 다시 부른다. 이전 데이터는 새로 불러오는 동안 유지 */
export function useAsync<T>(load: () => Promise<T>, deps: unknown[]): [Async<T>, () => void, (fn: (d: T) => T) => void] {
  const [state, setState] = useState<Async<T>>({ status: "loading" });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    setState((s) => (s.status === "ok" ? s : { status: "loading" }));
    load().then(
      (data) => live && setState({ status: "ok", data }),
      (error) => live && setState({ status: "error", error }),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  const mutate = useCallback((fn: (d: T) => T) => setState((s) => (s.status === "ok" ? { status: "ok", data: fn(s.data) } : s)), []);
  return [state, reload, mutate];
}

/** 버튼 작업: 실행 중 표시 + 실패 시 토스트 */
export function useAction(): [boolean, (fn: () => Promise<void>) => Promise<void>] {
  const [busy, setBusy] = useState(false);
  const run = useCallback(async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      setBusy(false);
    }
  }, []);
  return [busy, run];
}

export function Toggle(props: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string; disabled?: boolean }) {
  return (
    <label class={"t-check" + (props.disabled ? " is-disabled" : "")}>
      <input type="checkbox" checked={props.checked} disabled={props.disabled} onChange={(e) => props.onChange((e.currentTarget as HTMLInputElement).checked)} />
      <span>
        <span class="t-check-label">{props.label}</span>
        {props.hint && <span class="hint t-block">{props.hint}</span>}
      </span>
    </label>
  );
}

export function Choice<T extends string>(props: {
  name: string;
  legend: string;
  value: T;
  options: Array<{ value: T; label: string; hint: string; disabled?: boolean }>;
  onChange: (v: T) => void;
}) {
  return (
    <fieldset class="t-choice">
      <legend class="label">{props.legend}</legend>
      <div class="t-choice-grid">
        {props.options.map((o) => (
          <label key={o.value} class={"t-choice-item" + (props.value === o.value ? " is-on" : "") + (o.disabled ? " is-disabled" : "")}>
            <input type="radio" name={props.name} value={o.value} checked={props.value === o.value} disabled={o.disabled} onChange={() => props.onChange(o.value)} />
            <span>
              <span class="t-check-label">{o.label}</span>
              <span class="hint t-block">{o.hint}</span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** 지우기 전에 이름을 그대로 쳐서 확인 */
export function TypeToConfirm(props: { title: string; expected: string; description: ComponentChildren; actionLabel: string; onConfirm: () => Promise<void>; onClose: () => void }) {
  const [value, setValue] = useState("");
  const [busy, run] = useAction();
  const ok = value.trim() === props.expected.trim();
  const submit = (e: JSX.TargetedEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!ok) return;
    void run(async () => {
      await props.onConfirm();
      props.onClose();
    });
  };
  return (
    <Modal title={props.title} onClose={props.onClose} busy={busy}>
      <form class="stack" onSubmit={submit}>
        <div class="t-warnbox">{props.description}</div>
        <div class="field">
          <label for="confirm-input">
            확인을 위해 <strong class="t-strong">{props.expected}</strong> 을(를) 그대로 입력해 주세요.
          </label>
          <input id="confirm-input" class="input" value={value} autoComplete="off" data-autofocus onInput={(e) => setValue((e.currentTarget as HTMLInputElement).value)} />
        </div>
        <div class="row t-end">
          <button type="button" class="btn" onClick={props.onClose} disabled={busy}>
            취소
          </button>
          <button type="submit" class="btn btn-danger-solid" disabled={!ok || busy}>
            {busy ? "지우는 중…" : props.actionLabel}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function downloadText(filename: string, text: string, mime = "text/csv;charset=utf-8"): void {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const prev = document.activeElement as HTMLElement | null;
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.append(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      prev?.focus?.();
      return ok;
    } catch {
      return false;
    }
  }
}
