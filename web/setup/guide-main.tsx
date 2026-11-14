/** 설치 전 공개 안내 페이지 진입점 (npm run build:guide → dist/guide/index.html). 설치된 나눔보드의 /setup 과 같은 화면을 쓴다. */
import { render } from "preact";
import { SetupPage } from "./SetupPage";

render(<SetupPage standalone />, document.getElementById("app")!);
