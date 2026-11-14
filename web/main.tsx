import { render } from "preact";
import { Router } from "./lib/router";
import { HomePage } from "./HomePage";
import { TeacherPage } from "./teacher/TeacherPage";
import { StudentBoardPage } from "./student/StudentBoardPage";
import { SetupPage } from "./setup/SetupPage";

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
      { path: "/teacher", component: TeacherPage },
      { path: "/b/:code", component: StudentBoardPage },
      { path: "/setup", component: SetupPage },
    ]}
    fallback={NotFound}
  />,
  document.getElementById("app")!,
);
