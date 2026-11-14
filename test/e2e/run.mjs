/**
 * 브라우저·부하 시험 실행기.
 *   node test/e2e/run.mjs --serve      빌드 → 깨끗한 상태로 시험 서버만 띄움 (Ctrl+C 로 끝)
 *   node test/e2e/run.mjs scenario     빌드 → 서버 → test/e2e/scenario.cjs (Playwright) → 서버 끔
 *   node test/e2e/run.mjs load         빌드 → 서버 → test/e2e/load.mjs (웹소켓 50명 부하) → 서버 끔
 * 환경 변수: PORT(기본 8791), OUT(스크린숏 폴더, 기본 ./e2e-shots), SKIP_BUILD=1(빌드 생략)
 * Playwright 는 이 저장소 의존성이 아니다. 시험하는 컴퓨터에 전역으로 설치된 것을 쓴다 (`require("playwright")`).
 */
import { spawn, spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../..", import.meta.url));
const port = Number(process.env.PORT || 8791);
const base = `http://localhost:${port}`;
const stateDir = path.join(root, ".wrangler", "e2e-state");
const arg = process.argv[2] || "scenario";
const bin = (name) => path.join(root, "node_modules", ".bin", name);

if (!process.env.SKIP_BUILD) {
  const b = spawnSync(bin("vite"), ["build", "--config", "web/vite.config.ts"], { cwd: root, stdio: "inherit" });
  if (b.status !== 0) process.exit(b.status ?? 1);
}
rmSync(stateDir, { recursive: true, force: true });

const server = spawn(
  bin("wrangler"),
  ["dev", "-c", "test/e2e/wrangler.jsonc", "--port", String(port), "--ip", "127.0.0.1", "--persist-to", stateDir, "--show-interactive-dev-session=false"],
  { cwd: root, stdio: arg === "--serve" ? "inherit" : ["ignore", "pipe", "pipe"], env: { ...process.env, CI: "1" } },
);
let log = "";
server.stdout?.on("data", (d) => (log += d));
server.stderr?.on("data", (d) => (log += d));
const stop = () => {
  if (!server.killed) server.kill("SIGINT");
};
process.on("SIGINT", () => {
  stop();
  process.exit(130);
});

async function waitReady() {
  const t0 = Date.now();
  while (Date.now() - t0 < 60_000) {
    try {
      const r = await fetch(`${base}/api/me`);
      if (r.ok) return;
    } catch {
      /* 아직 */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  console.error(log);
  throw new Error("시험 서버가 60초 안에 뜨지 않았어요");
}

await waitReady();
if (arg === "--serve") {
  console.log(`\n시험 서버: ${base}  (교사로 들어가기: ${base}/__test/login)`);
} else {
  const script = arg === "load" ? "test/e2e/load.mjs" : "test/e2e/scenario.cjs";
  const child = spawn(process.execPath, [script, ...process.argv.slice(3)], { cwd: root, stdio: "inherit", env: { ...process.env, BASE: base } });
  const code = await new Promise((r) => child.on("exit", (c) => r(c ?? 1)));
  stop();
  if (code !== 0 && process.env.SHOW_SERVER_LOG) console.error(log);
  process.exit(code);
}
