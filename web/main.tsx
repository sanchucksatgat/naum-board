import { render } from "preact";
import { Router } from "./lib/router";
import { HomePage } from "./HomePage";
import { useEffect, useState } from "preact/hooks";
import { StudentBoardPage } from "./student/StudentBoardPage";
import { SetupPage } from "./setup/SetupPage";

// 교사 화면은 따로 나눠 불러온다 (학생 화면이 교사 코드를 받지 않게). 모든 /teacher/* 경로가 같은 컴포넌트라 이동해도 다시 마운트되지 않는다.
let teacherModule: Promise<typeof import("./teacher/TeacherPage")> | null = null;
function TeacherRoute() {
  const [mod, setMod] = useState<typeof import("./teacher/TeacherPage") | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    teacherModule ??= import("./teacher/TeacherPage");
    teacherModule.then(setMod, () => {
      teacherModule = null;
      setFailed(true);
    });
  }, []);
  if (failed)
    return (
      <main>
        <p>화면을 불러오지 못했어요. 인터넷 연결을 확인하고 새로 고쳐 주세요.</p>
      </main>
    );
  return mod ? <mod.TeacherPage /> : null;
}

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
      { path: "/setup", component: SetupPage },
    ]}
    fallback={NotFound}
  />,
  document.getElementById("app")!,
);
