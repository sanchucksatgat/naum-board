import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";

/** 클립보드 복사 (권한이 없으면 임시 textarea 로 대체) */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

/** 복사할 값 한 줄: 이름표 + 값 + [복사] 버튼 */
export function CopyField(props: { label: string; value: string; hint?: ComponentChildren; big?: boolean }) {
  const [state, setState] = useState<"idle" | "ok" | "fail">("idle");
  const timer = useRef<number>();
  useEffect(() => () => clearTimeout(timer.current), []);
  const onCopy = async () => {
    const ok = await copyText(props.value);
    setState(ok ? "ok" : "fail");
    clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState("idle"), 2500);
  };
  return (
    <div class="su-copy">
      <div class="su-copy-label">{props.label}</div>
      <div class="su-copy-row">
        <code class={`su-copy-value${props.big ? " su-copy-big" : ""}`}>{props.value}</code>
        <button type="button" class={`btn btn-small ${state === "ok" ? "btn-primary" : ""}`} onClick={onCopy} aria-label={`${props.label} 복사`}>
          {state === "ok" ? "복사됨 ✓" : state === "fail" ? "직접 복사해 주세요" : "복사"}
        </button>
      </div>
      {props.hint && <div class="hint">{props.hint}</div>}
      <span class="sr-only" aria-live="polite">
        {state === "ok" ? `${props.label} 복사했어요` : ""}
      </span>
    </div>
  );
}

export function Callout(props: { kind?: "info" | "warn" | "ok" | "danger"; title?: string; children: ComponentChildren }) {
  const kind = props.kind ?? "info";
  const icon = { info: "i", warn: "!", ok: "✓", danger: "!" }[kind];
  return (
    <div class={`su-callout su-callout-${kind}`} role={kind === "danger" || kind === "warn" ? "note" : undefined}>
      <span class="su-callout-icon" aria-hidden="true">
        {icon}
      </span>
      <div>
        {props.title && <strong class="su-callout-title">{props.title}</strong>}
        <div>{props.children}</div>
      </div>
    </div>
  );
}

/** 따라 할 순서 목록 */
export function Steps(props: { children: ComponentChildren }) {
  return <ol class="su-steps">{props.children}</ol>;
}

/** 화면에 보이는 글자(버튼 이름 등) 표시: 한국어 (영어) */
export function UI(props: { ko: string; en?: string }) {
  return (
    <span class="su-ui">
      {props.ko}
      {props.en && props.en !== props.ko && <span class="su-ui-en"> ({props.en})</span>}
    </span>
  );
}

/** 바깥 사이트로 가는 링크 (새 탭) */
export function Ext(props: { href: string; children: ComponentChildren; button?: boolean }) {
  return (
    <a href={props.href} target="_blank" rel="noopener noreferrer" class={props.button ? "btn btn-primary su-ext-btn" : undefined}>
      {props.children}
      <span aria-hidden="true"> ↗</span>
      <span class="sr-only"> (새 탭에서 열림)</span>
    </a>
  );
}

/** 처음 나오는 어려운 말을 한 줄로 풀어 줌 */
export function Term(props: { word: string; children: ComponentChildren }) {
  return (
    <span class="su-term">
      <strong>{props.word}</strong>
      <span class="su-term-desc">({props.children})</span>
    </span>
  );
}

/* ───────── 화면 모형 (실제 화면을 단순화한 그림. 상표·스크린샷 아님) ───────── */

export function Mock(props: { app: string; url?: string; menu?: { items: string[]; active?: number }; caption: string; children: ComponentChildren }) {
  return (
    <figure class="su-mock">
      <div class="su-mock-frame" aria-hidden="true">
        <div class="su-mock-bar">
          <span class="su-mock-dots">
            <i />
            <i />
            <i />
          </span>
          <span class="su-mock-url">{props.url ?? props.app}</span>
        </div>
        <div class={`su-mock-body${props.menu ? " su-mock-has-menu" : ""}`}>
          {props.menu && (
            <ul class="su-mock-menu">
              {props.menu.items.map((it, i) => (
                <li key={it} class={i === props.menu!.active ? "su-mock-menu-active" : undefined}>
                  {it}
                </li>
              ))}
            </ul>
          )}
          <div class="su-mock-main">{props.children}</div>
        </div>
      </div>
      <figcaption class="hint">
        <span class="su-mock-tag">그림</span> {props.caption}
      </figcaption>
    </figure>
  );
}

function Hl(props: { n?: number; children: ComponentChildren; block?: boolean }) {
  if (props.n === undefined) return <>{props.children}</>;
  return (
    <span class={`su-hl${props.block ? " su-hl-block" : ""}`}>
      <b class="su-hl-n">{props.n}</b>
      {props.children}
    </span>
  );
}

export function MTitle(props: { children: ComponentChildren }) {
  return <div class="su-m-title">{props.children}</div>;
}
export function MText(props: { children: ComponentChildren }) {
  return <div class="su-m-text">{props.children}</div>;
}
export function MField(props: { label: string; value?: string; hl?: number; placeholder?: string }) {
  return (
    <Hl n={props.hl} block>
      <div class="su-m-field">
        <div class="su-m-label">{props.label}</div>
        <div class={`su-m-input${props.value ? "" : " su-m-placeholder"}`}>{props.value ?? props.placeholder ?? ""}</div>
      </div>
    </Hl>
  );
}
export function MButton(props: { label: string; hl?: number; primary?: boolean }) {
  return (
    <Hl n={props.hl}>
      <span class={`su-m-btn${props.primary ? " su-m-btn-primary" : ""}`}>{props.label}</span>
    </Hl>
  );
}
export function MChoice(props: { options: string[]; selected: number; hl?: number; check?: boolean }) {
  return (
    <Hl n={props.hl} block>
      <div class="su-m-choices">
        {props.options.map((o, i) => (
          <div class="su-m-choice" key={o}>
            <span class={`${props.check ? "su-m-check" : "su-m-radio"}${i === props.selected ? " su-m-on" : ""}`} />
            {o}
          </div>
        ))}
      </div>
    </Hl>
  );
}
export function MRow(props: { children: ComponentChildren; end?: boolean }) {
  return <div class={`su-m-row${props.end ? " su-m-row-end" : ""}`}>{props.children}</div>;
}
