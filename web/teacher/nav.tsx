/** 교사 화면 안의 주소 처리 (/teacher/...). 공용 라우터는 경로만 보므로 주소 쿼리는 여기서 직접 읽는다. */
import type { ComponentChildren, JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import { navigate } from "../lib/router";

export interface Loc {
  /** "/teacher" 뒤의 조각들. 예: /teacher/classes/c1 → ["classes", "c1"] */
  parts: string[];
  query: URLSearchParams;
}

function read(): Loc {
  const parts = location.pathname.split("/").filter(Boolean).slice(1).map(decodeURIComponent);
  return { parts, query: new URLSearchParams(location.search) };
}

export function useLoc(): Loc {
  const [loc, setLoc] = useState(read);
  useEffect(() => {
    const on = () => {
      setLoc(read());
    };
    addEventListener("popstate", on);
    return () => removeEventListener("popstate", on);
  }, []);
  return loc;
}

export function go(to: string, opts: { replace?: boolean } = {}): void {
  if (opts.replace) {
    history.replaceState(null, "", to);
    dispatchEvent(new PopStateEvent("popstate"));
  } else navigate(to);
  window.scrollTo({ top: 0 });
}

/** 같은 앱 안 이동 링크 (새 탭·가운데 클릭은 브라우저 기본 동작) */
export function Link(props: { href: string; class?: string; children: ComponentChildren; "aria-current"?: JSX.AriaAttributes["aria-current"]; title?: string }) {
  return (
    <a
      href={props.href}
      class={props.class}
      aria-current={props["aria-current"]}
      title={props.title}
      onClick={(e) => {
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        go(props.href);
      }}
    >
      {props.children}
    </a>
  );
}
