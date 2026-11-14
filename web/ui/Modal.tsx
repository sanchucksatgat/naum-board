import type { ComponentChildren } from "preact";
import { useEffect, useRef } from "preact/hooks";
import { createPortal } from "preact/compat";

/**
 * 대화상자. 휴대폰(≤600px)에서는 tokens.css 규칙대로 아래에서 올라오는 시트가 된다.
 * - 열리면 첫 입력칸(또는 대화상자)에 초점, 닫히면 원래 자리로 초점을 돌려준다.
 * - Tab 은 대화상자 안에서만 돈다. Esc·바깥 누르기로 닫힌다 (맨 위 대화상자만).
 */
export interface ModalProps {
  title: ComponentChildren;
  onClose: () => void;
  children: ComponentChildren;
  /** 아래 단추 줄 */
  footer?: ComponentChildren;
  /** 넓은 대화상자 */
  wide?: boolean;
  /** 바깥을 눌러도 안 닫힘 (쓰던 글이 있을 때 등) */
  persistent?: boolean;
  /** 처음 초점을 줄 요소 선택자 */
  initialFocus?: string;
  class?: string;
  /** 제목 숨김 (스크린리더에는 읽힘) */
  hideTitle?: boolean;
}

const stack: symbol[] = [];
let scrollLockCount = 0;

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

let idSeq = 0;

export function Modal(props: ModalProps) {
  const ref = useRef<HTMLDivElement>(null);
  const me = useRef(Symbol("modal"));
  const titleId = useRef(`modal-title-${++idSeq}`);
  const onCloseRef = useRef(props.onClose);
  onCloseRef.current = props.onClose;

  useEffect(() => {
    const id = me.current;
    stack.push(id);
    const prevFocus = document.activeElement as HTMLElement | null;
    if (scrollLockCount++ === 0) document.documentElement.style.overflow = "hidden";
    const el = ref.current;
    if (el) {
      const first =
        (props.initialFocus ? el.querySelector<HTMLElement>(props.initialFocus) : null) ??
        el.querySelector<HTMLElement>("input:not([type=hidden]):not([disabled]), textarea, select") ??
        el;
      // 휴대폰에서 시트가 올라오는 동안 키보드가 튀지 않게 한 틱 뒤에
      requestAnimationFrame(() => first.focus({ preventScroll: true }));
    }
    const onKey = (e: KeyboardEvent) => {
      if (stack[stack.length - 1] !== id) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key === "Tab" && ref.current) {
        const items = Array.from(ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((x) => x.offsetParent !== null || x === document.activeElement);
        if (items.length === 0) {
          e.preventDefault();
          return;
        }
        const first = items[0]!;
        const last = items[items.length - 1]!;
        const active = document.activeElement;
        if (e.shiftKey && (active === first || !ref.current.contains(active))) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && (active === last || !ref.current.contains(active))) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      const i = stack.indexOf(id);
      if (i >= 0) stack.splice(i, 1);
      if (--scrollLockCount === 0) document.documentElement.style.overflow = "";
      if (prevFocus && document.contains(prevFocus)) prevFocus.focus({ preventScroll: true });
    };
  }, []);

  // body 로 옮겨 그린다: 카드(content-visibility)·고정 윗줄(z-index) 안에 갇히지 않게
  return createPortal(
    <div
      class="modal-backdrop"
      onMouseDown={(e) => {
        if (!props.persistent && e.target === e.currentTarget) props.onClose();
      }}
    >
      <div
        ref={ref}
        class={"modal ui-modal" + (props.wide ? " ui-modal-wide" : "") + (props.class ? " " + props.class : "")}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId.current}
        tabIndex={-1}
      >
        <div class="ui-modal-head">
          <h2 id={titleId.current} class={props.hideTitle ? "sr-only" : "ui-modal-title"}>
            {props.title}
          </h2>
          <button type="button" class="btn btn-ghost ui-icon-btn" aria-label="닫기" onClick={() => props.onClose()}>
            ✕
          </button>
        </div>
        <div class="ui-modal-body">{props.children}</div>
        {props.footer ? <div class="ui-modal-foot">{props.footer}</div> : null}
      </div>
    </div>,
    document.body,
  );
}
