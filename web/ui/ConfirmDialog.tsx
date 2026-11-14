import { useEffect, useState } from "preact/hooks";
import { Modal } from "./Modal";

/**
 * 확인 대화상자. `if (await confirmDialog({ title: "지울까요?", danger: true })) …`
 * <DialogHost/> 를 한 번 두어야 한다 (UiHost 에 들어 있음).
 */
export interface ConfirmOptions {
  title: string;
  message?: string;
  okLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

interface Pending extends ConfirmOptions {
  resolve: (ok: boolean) => void;
}

let current: Pending | null = null;
const listeners = new Set<() => void>();

export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    current?.resolve(false);
    current = { ...opts, resolve };
    for (const fn of listeners) fn();
  });
}

function finish(ok: boolean) {
  const c = current;
  current = null;
  c?.resolve(ok);
  for (const fn of listeners) fn();
}

export function DialogHost() {
  const [, force] = useState(0);
  useEffect(() => {
    const fn = () => force((n) => n + 1);
    listeners.add(fn);
    return () => listeners.delete(fn);
  }, []);
  const c = current;
  if (!c) return null;
  return (
    <Modal
      title={c.title}
      onClose={() => finish(false)}
      initialFocus=".ui-confirm-ok"
      footer={
        <>
          <button type="button" class="btn" onClick={() => finish(false)}>
            {c.cancelLabel ?? "취소"}
          </button>
          <button type="button" class={"btn ui-confirm-ok " + (c.danger ? "btn-danger-solid" : "btn-primary")} onClick={() => finish(true)}>
            {c.okLabel ?? "확인"}
          </button>
        </>
      }
    >
      {c.message ? <p class="ui-confirm-msg">{c.message}</p> : null}
    </Modal>
  );
}
