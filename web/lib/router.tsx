import type { ComponentType } from "preact";
import { useEffect, useState } from "preact/hooks";

/** 아주 작은 경로 라우터 (의존성 없이). 패턴 예: "/b/:code" */
export interface Route {
  path: string;
  component: ComponentType<{ params: Record<string, string> }>;
}

export function matchPath(pattern: string, pathname: string): Record<string, string> | null {
  const p = pattern.split("/").filter(Boolean);
  const s = pathname.split("/").filter(Boolean);
  if (p.length !== s.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < p.length; i++) {
    const seg = p[i]!;
    const val = s[i]!;
    if (seg.startsWith(":")) params[seg.slice(1)] = decodeURIComponent(val);
    else if (seg !== val) return null;
  }
  return params;
}

/** 페이지 이동 (전체 새로고침 없이) */
export function navigate(to: string): void {
  history.pushState(null, "", to);
  dispatchEvent(new PopStateEvent("popstate"));
}

export function Router(props: { routes: Route[]; fallback: ComponentType }) {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const onPop = () => setPath(location.pathname);
    addEventListener("popstate", onPop);
    return () => removeEventListener("popstate", onPop);
  }, []);
  for (const r of props.routes) {
    const params = matchPath(r.path, path);
    if (params) {
      const C = r.component;
      return <C params={params} />;
    }
  }
  const F = props.fallback;
  return <F />;
}
