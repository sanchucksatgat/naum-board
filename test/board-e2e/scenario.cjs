/* 보드 화면 브라우저 시나리오 (태스크4). 실행 전에 test/board-e2e/wrangler.jsonc 로 wrangler dev 를 띄운다.
 *   BASE=http://localhost:8791 OUT=/path/to/shots node test/board-e2e/scenario.cjs
 * 교사(데스크톱) + 학생 A(휴대폰 360×740) + 학생 B(데스크톱) 세 브라우저 문맥으로 실시간 동작을 확인한다. */
const { chromium } = require("playwright");
const zlib = require("node:zlib");
const fs = require("node:fs");
const path = require("node:path");

const BASE = process.env.BASE || "http://localhost:8791";
const OUT = process.env.OUT || path.join(process.cwd(), "shots");
fs.mkdirSync(OUT, { recursive: true });

// ── 작은 PNG 만들기 (그라데이션) ──
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function png(w, h) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const i = y * (w * 3 + 1) + 1 + x * 3;
      raw[i] = Math.round((x / w) * 255);
      raw[i + 1] = Math.round((y / h) * 200) + 40;
      raw[i + 2] = 160;
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

const results = [];
function ok(name, cond, extra = "") {
  results.push({ name, pass: !!cond, extra });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`);
}
async function step(name, fn) {
  try {
    await fn();
  } catch (e) {
    ok(name, false, String(e && e.message ? e.message.split("\n")[0] : e));
  }
}

async function noHScroll(page) {
  return page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
}

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const watch = (page, who) => {
    page.on("pageerror", (e) => errors.push(`${who}: ${e.message}`));
    page.on("console", (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && errors.push(`${who} console: ${m.text()}`));
  };
  // 브라우저 → Drive 직접 PUT 은 막는다 (CORS 실패 흉내) → upload.ts 가 Worker 프록시로 자동 전환
  const blockDrive = (ctx) => ctx.route("https://www.googleapis.com/**", (r) => r.abort());

  // ── 교사 ──
  const tctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 2 });
  await blockDrive(tctx);
  const teacher = await tctx.newPage();
  watch(teacher, "teacher");
  await teacher.goto(BASE + "/__test/login?to=/");
  const me = await teacher.evaluate(() => fetch("/api/me").then((r) => r.json()));
  ok("교사 시험 세션 (Secure __Host- 쿠키가 http://localhost 에서 동작)", me.authenticated === true, JSON.stringify(me).slice(0, 80));

  const setup = await teacher.evaluate(async () => {
    const post = (u, b) => fetch(u, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then(async (r) => ({ status: r.status, body: await r.json() }));
    const cls = await post("/api/teacher/classes", {
      name: "3학년 2반",
      students: [
        { number: "20301", name: "김하나", pin: "4821", group: "1모둠" },
        { number: "20302", name: "이두리", pin: "5932", group: "1모둠" },
        { number: "20303", name: "박세찬", pin: "7710", group: "2모둠" },
      ],
    });
    const board = await post("/api/teacher/boards", { title: "새싹 관찰 일기", classId: cls.body.class.id, type: "cumulative", columnMode: "student", entryMode: "roster", description: "오늘 본 새싹의 모습을 사진과 글로 남겨요." });
    return { cls, board };
  });
  const code = setup.board.body.code;
  ok("REST 로 반·명단·보드 만들기", setup.board.status === 201 && code, `code=${code}`);

  await teacher.goto(`${BASE}/b/${code}`);
  await teacher.waitForSelector(".tbar", { timeout: 15000 });
  ok("교사: /b/코드 에서 교사 도구가 보임 (쿠키로 접속)", await teacher.isVisible("text=🔒 잠그기"));

  // ── 학생 A: 휴대폰 ──
  const actx = await browser.newContext({ viewport: { width: 360, height: 740 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await blockDrive(actx);
  const A = await actx.newPage();
  watch(A, "A");
  await A.goto(`${BASE}/b/${code}`);
  await A.fill("#entry-number", "20301");
  await A.fill("#entry-pin", "4821");
  await A.screenshot({ path: path.join(OUT, "01-phone-entry.png") });
  await A.click("button[type=submit]");
  await A.waitForSelector("#pin-new");
  await A.fill("#pin-new", "1111");
  await A.fill("#pin-again", "1111");
  await A.click("button[type=submit]");
  ok("학생 A: 쉬운 PIN 거절 안내", await A.isVisible("text=너무 쉬운 PIN"));
  await A.fill("#pin-new", "2580");
  await A.fill("#pin-again", "2580");
  await A.click("button[type=submit]");
  await A.waitForSelector(".wall", { timeout: 15000 });
  ok("학생 A: 처음 입장 → 나만의 PIN → 보드", true);
  ok("학생 A: 휴대폰 가로 스크롤 없음", await noHScroll(A));

  // ── 학생 B: 데스크톱 ──
  const bctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
  await blockDrive(bctx);
  const B = await bctx.newPage();
  watch(B, "B");
  await B.goto(`${BASE}/b/${code}`);
  await B.fill("#entry-number", "20302");
  await B.fill("#entry-pin", "0000");
  await B.click("button[type=submit]");
  await B.waitForSelector(".error-text");
  ok("학생 B: 틀린 PIN 안내", (await B.textContent(".error-text")).includes("다시 확인"));
  await B.fill("#entry-pin", "5932");
  await B.click("button[type=submit]");
  await B.waitForSelector("#pin-new");
  await B.fill("#pin-new", "1357");
  await B.fill("#pin-again", "1357");
  await B.click("button[type=submit]");
  await B.waitForSelector(".wall", { timeout: 15000 });

  // ── A: 글쓰기 (휴대폰 떠 있는 단추) ──
  await step("A 글 올리기", async () => {
    await A.click(".fab");
    await A.waitForSelector("#composer-title");
    await A.screenshot({ path: path.join(OUT, "02-phone-composer.png") });
    await A.fill("#composer-title", "떡잎이 나왔어요");
    await A.fill("#composer-body", "오늘 아침에 보니 떡잎 두 장이 올라왔어요. 🌱");
    const t0 = Date.now();
    await A.click(".composer-send");
    await A.waitForSelector(".bcard >> text=떡잎이 나왔어요", { timeout: 3000 });
    ok("A: 올리자마자 내 화면에 카드 (낙관적)", true, `${Date.now() - t0}ms`);
    const t1 = Date.now();
    await B.waitForSelector(".bcard >> text=떡잎이 나왔어요", { timeout: 5000 });
    ok("B: 새로 고침 없이 A 의 카드가 나타남", true, `${Date.now() - t1}ms 뒤`);
    await teacher.waitForSelector(".bcard >> text=떡잎이 나왔어요", { timeout: 5000 });
    ok("교사: A 의 카드가 실시간으로 보임", true);
  });

  // ── B: 사진 글 (업로드 → Worker 프록시 → 가짜 Drive) ──
  await step("B 사진 올리기", async () => {
    await B.click(".col.is-mine .col-add");
    await B.waitForSelector("#composer-title");
    await B.fill("#composer-title", "우리 콩 화분");
    await B.setInputFiles(".composer-tools input[type=file][multiple]", { name: "sprout.png", mimeType: "image/png", buffer: png(1200, 900) });
    await B.waitForSelector(".composer-item.is-done", { timeout: 20000 });
    ok("B: 사진 업로드 완료 (압축 → 세션 → 프록시 PUT → complete)", true, await B.textContent(".composer-item .hint"));
    await B.screenshot({ path: path.join(OUT, "03-desktop-composer-upload.png") });
    await B.click(".composer-send");
    await B.waitForSelector(".bcard >> text=우리 콩 화분");
    const imgOk = await A.waitForFunction(
      () => {
        const card = [...document.querySelectorAll(".bcard")].find((c) => c.textContent.includes("우리 콩 화분"));
        const img = card && card.querySelector("img.bcard-img");
        return img && img.complete && img.naturalWidth > 0 ? { w: img.naturalWidth, src: img.getAttribute("src"), wa: img.getAttribute("width"), ha: img.getAttribute("height") } : null;
      },
      null,
      { timeout: 15000 },
    );
    const info = await imgOk.jsonValue();
    ok("A: B 의 사진이 /api/files/... 로 실제로 뜸 (width/height 속성 있음)", info && info.src.startsWith("/api/files/") && info.wa && info.ha, JSON.stringify(info));
  });

  // ── 댓글·좋아요 ──
  await step("댓글·좋아요", async () => {
    const card = A.locator(".bcard", { hasText: "우리 콩 화분" });
    await card.locator(".bcard-like").click();
    await card.locator("button[aria-label^='댓글']").click();
    await A.fill("#comment-input", "와 콩이 엄청 커요!");
    await A.click(".comment-form button[type=submit]");
    await A.waitForSelector(".comment >> text=와 콩이 엄청 커요!");
    await A.screenshot({ path: path.join(OUT, "04-phone-comments.png") });
    await A.keyboard.press("Escape");
    const bcard = B.locator(".bcard", { hasText: "우리 콩 화분" });
    await bcard.locator(".bcard-like span", { hasText: "1" }).waitFor({ timeout: 5000 });
    ok("B: A 가 누른 좋아요 수가 실시간으로 1", true);
    await bcard.locator("button[aria-label='댓글 1개 보기']").waitFor({ timeout: 5000 });
    ok("B: 댓글 수가 실시간으로 1", true);
  });

  // ── 교사 피드백 (작성자만) ──
  await step("피드백", async () => {
    const tcard = teacher.locator(".bcard", { hasText: "우리 콩 화분" });
    await tcard.locator("text=📝 피드백").click();
    await teacher.fill("#fb-body", "사진을 잘 찍었어요. 잎 개수도 세어 볼까요?");
    await teacher.click("#fb-form ~ * button[type=submit], .ui-modal-foot button[type=submit]");
    await B.waitForSelector(".bcard-feedback >> text=잎 개수", { timeout: 5000 });
    ok("B(작성자): 선생님 피드백이 보임", true);
    await A.waitForTimeout(800);
    ok("A(다른 학생): 피드백이 안 보임", (await A.locator(".bcard-feedback").count()) === 0);
  });

  await B.screenshot({ path: path.join(OUT, "05-desktop-student.png") });
  await A.screenshot({ path: path.join(OUT, "06-phone-student.png") });
  await teacher.screenshot({ path: path.join(OUT, "07-teacher.png") });

  // ── 교사가 A 카드 숨기기 → B 화면에서 사라짐 ──
  await step("숨기기", async () => {
    const tcard = teacher.locator(".bcard", { hasText: "떡잎이 나왔어요" });
    await tcard.locator("text=🙈 숨기기").click();
    await B.locator(".bcard", { hasText: "떡잎이 나왔어요" }).waitFor({ state: "detached", timeout: 5000 });
    ok("B: 교사가 숨긴 카드가 새로 고침 없이 사라짐", true);
    await A.waitForSelector(".bcard.is-hidden >> text=선생님이 숨겼어요", { timeout: 5000 });
    ok("A(작성자): 숨김 상태가 표시됨", true);
    await A.screenshot({ path: path.join(OUT, "08-phone-hidden.png") });
    await tcard.locator("text=👁️ 다시 보이기").click();
    await B.waitForSelector(".bcard >> text=떡잎이 나왔어요", { timeout: 5000 });
    ok("B: 다시 보이기 하면 돌아옴", true);
  });

  // ── 익명 모드 ──
  await step("익명", async () => {
    await teacher.click("text=⚙️ 빠른 설정");
    await teacher.click("[role=switch]:has-text('익명 모드')");
    await teacher.click(".ui-confirm-ok");
    await B.waitForSelector(".banner >> text=익명 보드", { timeout: 5000 });
    await B.waitForTimeout(300);
    const text = await B.textContent(".wall");
    ok("B: 익명 모드에서 다른 학생 이름이 안 보임", !text.includes("김하나") && !text.includes("박세찬") && text.includes("익명"), text.slice(0, 80));
    await B.screenshot({ path: path.join(OUT, "09-desktop-anonymous.png") });
    await teacher.click("[role=switch]:has-text('익명 모드')");
    await teacher.click(".ui-confirm-ok");
    await teacher.keyboard.press("Escape");
  });

  // ── 잠금 ──
  await step("잠금", async () => {
    await teacher.click("text=🔒 잠그기");
    await A.waitForSelector(".banner-lock", { timeout: 5000 });
    ok("A: 잠금 띠가 보임", true);
    ok("A: 잠금 중에는 글쓰기 단추가 없음", (await A.locator(".fab").count()) === 0 && (await A.locator(".col-add").count()) === 0);
    ok("A: 잠금 중 좋아요 단추 비활성", await A.locator(".bcard-like").first().isDisabled());
    await A.screenshot({ path: path.join(OUT, "10-phone-locked.png") });
    await teacher.click("text=🔓 잠금 풀기");
    await A.waitForSelector(".fab", { timeout: 5000 });
    ok("A: 잠금을 풀면 글쓰기 단추가 돌아옴", true);
  });

  // ── 프로젝터 ──
  await step("프로젝터", async () => {
    const proj = await tctx.newPage();
    watch(proj, "projector");
    await proj.goto(`${BASE}/b/${code}?view=projector&names=0`);
    await proj.waitForSelector(".proj-head");
    ok("프로젝터: 교사 도구·글쓰기 없음", (await proj.locator(".tbar, .col-add, .bcard-teacher").count()) === 0);
    await proj.screenshot({ path: path.join(OUT, "11-projector.png") });
    await proj.close();
  });

  // ── 다크 모드 ──
  for (const [p, name] of [[A, "12-phone-dark.png"], [B, "13-desktop-dark.png"], [teacher, "14-teacher-dark.png"]]) {
    await p.emulateMedia({ colorScheme: "dark" });
    await p.waitForTimeout(200);
    await p.screenshot({ path: path.join(OUT, name) });
  }
  await A.emulateMedia({ colorScheme: "light" });


  // ── 성능: 카드 150장 + 실시간 변경분 ──
  await step("성능", async () => {
    await B.evaluate(() => {
      window.__long = [];
      new PerformanceObserver((l) => l.getEntries().forEach((e) => window.__long.push(Math.round(e.duration)))).observe({ type: "longtask", buffered: false });
    });
    const sent = await teacher.evaluate(async (code) => {
      const ws = new WebSocket(`ws://${location.host}/api/boards/${code}/ws`);
      await new Promise((r) => (ws.onopen = r));
      let acks = 0;
      ws.onmessage = (e) => { if (typeof e.data === "string" && e.data.includes('"t":"ack"')) acks++; };
      const N = 150;
      for (let i = 0; i < N; i++) {
        ws.send(JSON.stringify({ t: "post.save", opId: "perf-" + i + "-" + Date.now(), post: { title: "선생님 카드 " + i, body: "많은 카드 시험 ".repeat(5) } }));
        await new Promise((r) => setTimeout(r, 170));
      }
      const t0 = Date.now();
      while (acks < N && Date.now() - t0 < 15000) await new Promise((r) => setTimeout(r, 100));
      ws.close();
      return acks;
    }, code);
    await B.waitForFunction(() => document.querySelectorAll(".bcard").length >= 152, null, { timeout: 15000 });
    const long = await B.evaluate(() => window.__long);
    ok("B: 카드 150장이 실시간으로 쌓이는 동안 긴 작업(>50ms) 적음", long.length <= 3, `ack ${sent}, longtasks=${JSON.stringify(long)}`);
    // 변경분 하나가 반영되는 시간
    const t = await B.evaluate(() => {
      return new Promise((resolve) => {
        const card = [...document.querySelectorAll(".bcard")].find((c) => c.textContent.includes("떡잎이 나왔어요"));
        const btn = card.querySelector(".bcard-like");
        const t0 = performance.now();
        btn.click();
        requestAnimationFrame(() => resolve(Math.round(performance.now() - t0)));
      });
    });
    ok("B: 카드 150장 있을 때 좋아요 누르면 다음 프레임에 반영", t < 100, `${t}ms`);
    const dt = await A.evaluate(() => performance.now());
    await A.locator(".bcard", { hasText: "떡잎이 나왔어요" }).locator(".bcard-like span", { hasText: "1" }).waitFor({ timeout: 5000 });
    ok("A: 다른 학생의 좋아요가 실시간 반영", true, `${Math.round((await A.evaluate(() => performance.now())) - dt)}ms`);
    ok("A: 카드 많아도 휴대폰 가로 스크롤 없음", await noHScroll(A));
    await teacher.screenshot({ path: path.join(OUT, "16-teacher-many.png") });
  });

  // ── 휴대폰: 내 칸으로 가기 ──
  await step("내 칸으로 가기", async () => {
    await A.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await A.click(".col-jump-mine");
    await A.waitForTimeout(800);
    const top = await A.evaluate(() => document.querySelector(".col.is-mine").getBoundingClientRect().top);
    ok("A: 내 칸으로 가기 → 내 칸이 화면 위쪽", top >= 0 && top < 200, `top=${Math.round(top)}`);
  });

  // ── 재접속 (오프라인 → 온라인) ──
  await step("재접속", async () => {
    await actx.setOffline(true);
    await A.waitForSelector(".status-pill.is-offline, .status-pill.is-reconnecting", { timeout: 15000 });
    ok("A: 오프라인 표시", true, await A.textContent(".status-pill"));
    await actx.setOffline(false);
    await A.waitForSelector(".status-pill.is-open", { timeout: 20000 });
    ok("A: 다시 온라인 → 자동 재접속", true);
  });

  // ── 닉네임 ──
  await step("닉네임", async () => {
    await A.click(".topbar-me");
    await A.click("text=✏️ 닉네임 바꾸기");
    await A.fill("#nick-input", "별빛");
    await A.click("button[form=nick-form]");
    await A.waitForSelector(".topbar-me >> text=별빛", { timeout: 8000 });
    ok("A: 닉네임 변경이 바로 반영", true);
    await B.waitForSelector(".col-title >> text=별빛", { timeout: 8000 });
    ok("B: A 의 칸 이름이 닉네임으로 바뀜", true);
  });

  // ── 나가기 → 같은 기기 기억 ──
  await step("나가기와 기억", async () => {
    await A.click(".topbar-me");
    await A.click("text=🚪 나가기");
    await A.waitForSelector(".entry-who");
    ok("A: 나가면 '다른 사람이에요' 가 있는 기억된 학생 화면", await A.isVisible("text=다른 사람이에요"));
    await A.screenshot({ path: path.join(OUT, "15-phone-remembered.png") });
  });

  ok("페이지 오류 없음", errors.length === 0, errors.slice(0, 5).join(" | "));
  await browser.close();
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} 통과`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(2);
});
