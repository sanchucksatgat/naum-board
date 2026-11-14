import { render, type ComponentType } from "preact";
import { Router } from "./lib/router";
import { HomePage } from "./HomePage";
import { useEffect, useState } from "preact/hooks";
import { StudentBoardPage } from "./student/StudentBoardPage";

/**
 * 따로 나눠 불러오는 화면 (학생이 교사·설치 안내 코드를 받지 않게).
 * 모든 /teacher/* 경로가 같은 컴포넌트라 이동해도 다시 마운트되지 않는다.
 */
type RouteProps = { params: Record<string, string> };
function lazyRoute(load: () => Promise<ComponentType<RouteProps>>): ComponentType<RouteProps> {
  let pending: Promise<ComponentType<RouteProps>> | null = null;
  let loaded: ComponentType<RouteProps> | null = null;
  return function LazyRoute(props: RouteProps) {
    const [C, setC] = useState<ComponentType<RouteProps> | null>(() => loaded);
    const [failed, setFailed] = useState(false);
    useEffect(() => {
      if (C) return;
      pending ??= load();
      pending.then(
        (c) => {
          loaded = c;
          setC(() => c);
        },
        () => {
          pending = null;
          setFailed(true);
        },
      );
    }, []);
    if (failed)
      return (
        <main>
          <p>화면을 불러오지 못했어요. 인터넷 연결을 확인하고 새로 고쳐 주세요.</p>
        </main>
      );
    return C ? <C {...props} /> : null;
  };
}

const TeacherRoute = lazyRoute(() => import("./teacher/TeacherPage").then((m) => m.TeacherPage));
const SetupRoute = lazyRoute(() => import("./setup/SetupPage").then((m) => (p: RouteProps) => <m.SetupPage params={p.params} />));

function NotFound() {
  return (
    <main>
      <h1>페이지를 찾을 수 없어요</h1>
      <p>
        <a href="/">처음으로</a>
      </p>
    </main>
  );
}

render(
  <Router
    routes={[
      { path: "/", component: HomePage },
      { path: "/teacher", component: TeacherRoute },
      { path: "/teacher/:a", component: TeacherRoute },
      { path: "/teacher/:a/:b", component: TeacherRoute },
      { path: "/teacher/:a/:b/:c", component: TeacherRoute },
      { path: "/b/:code", component: StudentBoardPage },
      { path: "/setup", component: SetupRoute },
    ]}
    fallback={NotFound}
  />,
  document.getElementById("app")!,
);
