import { useEffect, useState } from "preact/hooks";

/** 화면 아래 잠깐 뜨는 알림. 어디서나 `toast("저장했어요")` 로 부른다. <ToastArea/> 는 한 번만 둔다. */
export type ToastKind = "info" | "error" | "success";

interface ToastItem {
  id: number;
  message: string;
  kind: ToastKind;
}

let items: ToastItem[] = [];
let seq = 0;
const listeners = new Set<() => void>();

function emit() {
  for (const fn of listeners) fn();
}

export function toast(message: string, opts: { kind?: ToastKind; ms?: number } = {}): void {
  // 같은 말이 연달아 오면 하나만
  if (items.some((t) => t.message === message)) return;
  const item: ToastItem = { id: ++seq, message, kind: opts.kind ?? "info" };
  items = [...items.slice(-2), item];
  emit();
  setTimeout(() => dismissToast(item.id), opts.ms ?? (item.kind === "error" ? 5000 : 3000));
}

export function dismissToast(id: number): void {
  const next = items.filter((t) => t.id !== id);
  if (next.length !== items.length) {
    items = next;
    emit();
  }
}

export function ToastArea() {
  const [, force] = useState(0);
  useEffect(() => {
    const fn = () => force((n) => n + 1);
    listeners.add(fn);
    return () => listeners.delete(fn);
  }, []);
  return (
    <div class="toast-area" role="status" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} class={"toast ui-toast ui-toast-" + t.kind} onClick={() => dismissToast(t.id)}>
          {t.kind === "error" ? "⚠️ " : t.kind === "success" ? "✅ " : ""}
          {t.message}
        </div>
      ))}
    </div>
  );
}
