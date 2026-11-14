/**
 * 설치 전 공개 안내 페이지만 따로 빌드한다 (GitHub Pages 등 아무 정적 호스팅에 올릴 수 있음).
 *   npm run build:guide  → dist/guide/index.html (+ assets/)
 * 상대 경로(base "./")라서 https://사용자.github.io/저장소/ 같은 하위 경로에서도 열린다.
 */
import { defineConfig, type Plugin } from "vite";
import preact from "@preact/preset-vite";

/** guide.html 을 index.html 로 내보낸다 */
const renameToIndex: Plugin = {
  name: "nanum-guide-index",
  enforce: "post",
  generateBundle(_opts, bundle) {
    const html = bundle["guide.html"];
    if (html) html.fileName = "index.html";
  },
};

export default defineConfig({
  root: "web/setup",
  base: "./",
  plugins: [preact(), renameToIndex],
  build: {
    outDir: "../../dist/guide",
    emptyOutDir: true,
    rollupOptions: { input: "web/setup/guide.html" },
  },
});
