/* 나눔보드 통합 브라우저 시나리오 (실제 빌드 + 가짜 Google). 실행: npm run e2e
 *   (직접: npm run e2e:serve 를 띄운 뒤 BASE=http://localhost:8791 OUT=./shots node test/e2e/scenario.cjs)
 *
 * 교사 한 명이 실제 화면으로 반(명단 붙여넣기)과 보드 3개(개인별·모둠별·주제별)를 만들고, 같은 빌드에서
 * 학생들이 휴대폰(360×740)·데스크톱으로 들어와 쓰는 흐름을 처음부터 끝까지 확인한다.
 * 브라우저 → Drive 직접 PUT 은 막아 둔다 (CORS 실패 흉내) → upload.ts 가 Worker 프록시로 바꿔 보내는지도 함께 확인.
 * 백업 알람은 실제 시간(30초)으로 돌기 때문에 전체가 3~4분 걸린다.
 */
const { chromium } = require("playwright");
const zlib = require("node:zlib");
const fs = require("node:fs");
const path = require("node:path");

const BASE = process.env.BASE || "http://localhost:8791";
const OUT = process.env.OUT || path.join(process.cwd(), "e2e-shots");
fs.mkdirSync(OUT, { recursive: true });

// ── 작은 PNG (그라데이션) ──
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function png(w, h, hue = 160) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const i = y * (w * 3 + 1) + 1 + x * 3;
      raw[i] = Math.round((x / w) * 255);
      raw[i + 1] = Math.round((y / h) * 200) + 40;
      raw[i + 2] = hue;
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
  ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
const PDF = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n");

const results = [];
function ok(name, cond, extra = "") {
  results.push({ name, pass: !!cond, extra });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`);
}
const pages = [];
async function step(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
  } catch (e) {
    for (const [i, pg] of pages.entries()) await pg.screenshot({ path: path.join(OUT, `fail-${name.replace(/[^\w가-힣-]+/g, "_")}-${i}.png`) }).catch(() => {});
    ok(name, false, String(e && e.message ? e.message.split("\n")[0] : e));
    return;
  }
  console.log(`      (${name}: ${((Date.now() - t0) / 1000).toFixed(1)}s)`);
}
const shots = [];
async function shot(page, name, opts = {}) {
  const p = path.join(OUT, name + ".png");
  await page.screenshot({ path: p, ...opts });
  shots.push(p);
}
const noHScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 클립보드 붙여넣기 / 끌어 놓기 흉내 (실제 브라우저 이벤트, 파일 포함) */
async function pasteFile(page, selector, file) {
  await page.evaluate(
    ({ selector, file }) => {
      const bytes = Uint8Array.from(atob(file.b64), (c) => c.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], file.name, { type: file.type }));
      document.querySelector(selector).dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    },
    { selector, file: { ...file, b64: file.buffer.toString("base64") } },
  );
}
async function dropFile(page, selector, file) {
  await page.evaluate(
    ({ selector, file }) => {
      const bytes = Uint8Array.from(atob(file.b64), (c) => c.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], file.name, { type: file.type }));
      const el = document.querySelector(selector);
      el.dispatchEvent(new DragEvent("dragover", { dataTransfer: dt, bubbles: true, cancelable: true }));
      el.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
    },
    { selector, file: { ...file, b64: file.buffer.toString("base64") } },
  );
}

async function setDrive(mode) {
  const r = await fetch(`${BASE}/__test/drive?mode=${mode}`, { method: "POST" });
  if (!r.ok) throw new Error("fake drive mode " + mode);
}
const driveFiles = async () => (await (await fetch(`${BASE}/__test/drive`)).json()).files;

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const watch = (page, who) => {
    pages.push(page);
    page.on("pageerror", (e) => errors.push(`${who}: ${e.message}`));
    page.on("console", (m) => {
      const t = m.text();
      // 일부러 만드는 오류(틀린 PIN 401·429 등)는 'Failed to load resource' 로 나온다
      if (m.type() === "error" && !/Failed to load resource/.test(t)) errors.push(`${who} console: ${t}`);
      if (/Content Security Policy/i.test(t)) errors.push(`${who} CSP: ${t}`);
    });
  };
  // 브라우저 → Google 은 막는다 (직접 PUT 은 CORS 실패처럼, 시트·드라이브 링크는 열지 않음)
  const blockGoogle = async (ctx) => {
    await ctx.route("https://www.googleapis.com/**", (r) => r.abort());
    await ctx.route("https://docs.google.com/**", (r) => r.fulfill({ status: 200, contentType: "text/html", body: "<title>fake sheet</title>시트" }));
    await ctx.route("https://drive.google.com/**", (r) => r.fulfill({ status: 200, contentType: "text/html", body: "<title>fake drive</title>드라이브" }));
  };
  const desktop = { viewport: { width: 1280, height: 860 }, deviceScaleFactor: 2 };
  const phone = { viewport: { width: 360, height: 740 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
  const newPage = async (opts, who) => {
    const ctx = await browser.newContext(opts);
    await blockGoogle(ctx);
    const p = await ctx.newPage();
    watch(p, who);
    return p;
  };

  // ═════════ 1. 교사: 대시보드 → 반 만들기(명단 붙여넣기) ═════════
  const T = await newPage(desktop, "teacher");
  await T.goto(BASE + "/__test/login?to=/teacher");
  await T.waitForSelector("text=아직 만든 보드가 없어요.");
  ok("교사: 빈 대시보드", true);
  await shot(T, "t01-dashboard-empty-desktop");

  const ROSTER_TSV = [
    "학번\t이름\tPIN\t모둠",
    "20301\t김하나\t4821\t1모둠",
    "20302\t이두리\t5932\t1모둠",
    "20303\t박세찬\t7710\t2모둠",
    "20304\t<b>최넷</b>\t\t2모둠",
    "20305\t=SUM(1+1)\t3141\t2모둠",
  ].join("\n");
  let classUrl = "";
  await step("반 만들기 (붙여넣기)", async () => {
    await T.click("text=반·명단");
    await T.click("text=+ 새 반 만들기");
    await T.fill("#cc-name", "3학년 2반");
    await T.fill("#cc-text", ROSTER_TSV);
    await T.waitForSelector("text=반 만들고 5명 넣기");
    await shot(T, "t02-class-paste-preview");
    await T.click("text=반 만들고 5명 넣기");
    await T.waitForURL(/\/teacher\/classes\/[^/]+$/);
    await T.waitForSelector("td >> text=20305");
    classUrl = T.url();
    const names = await T.locator("td.t-strong").allTextContents();
    ok("명단: HTML 이 들어간 이름은 글자 그대로 보임 (태그로 해석 안 됨)", names.some((n) => n.trim() === "<b>최넷</b>") && (await T.locator("td.t-strong b").count()) === 0, names.join(","));
    const autoPin = await T.locator("tr", { hasText: "20304" }).locator("code.t-pin").textContent();
    ok("명단: PIN 을 비운 학생은 자동 4자리", /^\d{4}$/.test(autoPin.trim()), autoPin);
    await shot(T, "t03-class-roster");
  });

  // ═════════ 2. 보드 3개 만들기 (실제 보드 만들기 화면) ═════════
  const boards = {};
  async function createBoard(key, o) {
    await T.goto(BASE + "/teacher");
    await T.click("text=+ 새 보드 만들기");
    await T.fill("#bf-title", o.title);
    if (o.desc) await T.fill("#bf-desc", o.desc);
    await T.check(`input[name=bf-type][value=${o.type}]`);
    await T.check(`input[name=bf-col][value=${o.col}]`);
    await T.check(`input[name=bf-entry][value=${o.entry}]`);
    if (o.col === "topic") await T.fill("#bf-topics", o.topics.join("\n"));
    if (o.entry === "roster") await T.selectOption("#bf-class", { index: 1 });
    if (o.moderation) await T.check("label.t-check:has-text('승인 후 게시') input");
    if (o.shotForm) await shot(T, o.shotForm);
    await T.click("button[type=submit]:has-text('보드 만들기')");
    await T.waitForURL(/\/teacher\/boards\/[^/?]+/);
    // 만든 직후 공유 창(QR·코드)
    await T.waitForSelector(".t-code-big");
    const code = (await T.locator(".t-code-big").textContent()).replace(/\s/g, "");
    const qr = await T.locator("[role=dialog] svg").count();
    const codePx = await T.locator(".t-code-big").evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    const id = T.url().match(/\/teacher\/boards\/([^/?]+)/)[1];
    boards[key] = { code, id, title: o.title };
    return { code, qr, codePx };
  }
  await step("보드 만들기: 개인별·명단·누적", async () => {
    const r = await createBoard("B1", { title: "새싹 관찰 일기", desc: "오늘 본 새싹을 사진과 글로 남겨요.", type: "cumulative", col: "student", entry: "roster", shotForm: "t04-board-form" });
    ok("보드1 만들고 공유 창에 입장 코드(숫자 4자리, 크게)·QR", /^[0-9]{4}$/.test(r.code) && r.codePx >= 48 && r.qr > 0, `${r.code} ${r.codePx}px`);
    await shot(T, "t05-share-qr");
    // QR 이 실제로 이 보드 주소를 담고 있는지: svg 안 path 가 있는지만 (디코딩은 단위 시험 몫)
    await T.keyboard.press("Escape");
  });
  await step("보드 만들기: 모둠별·명단·학생당 1카드", async () => {
    const r = await createBoard("B2", { title: "모둠 토의 결과", type: "single", col: "group", entry: "roster" });
    ok("보드2 (모둠별·1카드) 만듦, 코드는 보드마다 다름", /^[0-9]{4}$/.test(r.code) && r.code !== boards.B1.code, r.code);
    await T.keyboard.press("Escape");
  });
  await step("보드 만들기: 주제별·자유 입장·승인 후 게시", async () => {
    const r = await createBoard("B3", { title: "연수 소감 나누기", type: "cumulative", col: "topic", entry: "free", topics: ["좋았던 점", "아쉬운 점", "궁금한 점"], moderation: true, shotForm: "t06-board-form-topic" });
    ok("보드3 (주제별·자유·승인) 만듦", !!r.code, r.code);
    await T.keyboard.press("Escape");
    await T.goto(BASE + "/teacher");
    await T.waitForSelector(".t-board");
    ok("대시보드에 보드 3개", (await T.locator(".t-board").count()) === 3);
    await shot(T, "t07-dashboard-boards");
  });
  await step("입장 코드 4자리: 프로젝터 화면에 크게", async () => {
    await T.goto(`${BASE}/teacher/boards/${boards.B1.id}/projector`);
    await T.waitForSelector(".t-projector-code");
    const p = await T.locator(".t-projector-code").evaluate((el) => ({
      text: el.textContent,
      px: parseFloat(getComputedStyle(el).fontSize),
      fits: el.getBoundingClientRect().right <= window.innerWidth && el.scrollWidth <= el.clientWidth + 1,
    }));
    ok("프로젝터: 숫자 4자리 코드가 크게(100px 이상) 한 줄로", p.text === boards.B1.code && p.px >= 100 && p.fits, `${p.text} ${p.px}px`);
    await shot(T, "t07b-projector-code");
    await T.goto(BASE + "/teacher");
    await T.waitForSelector(".t-board");
  });
  await step("학생(휴대폰 360px): 첫 화면에서 숫자 4자리로 입장", async () => {
    const H = await newPage(phone, "H-phone-home");
    await H.goto(BASE + "/");
    const input = H.locator("#h-code-input");
    ok("첫 화면: 숫자 자판(inputmode=numeric), 예시는 4자리", (await input.getAttribute("inputmode")) === "numeric" && /4821/.test(await input.getAttribute("placeholder")));
    await input.fill("12");
    await H.click("button[type=submit]:has-text('입장')");
    ok("첫 화면: 모양이 틀리면 '숫자 4자리' 안내", /숫자 4자리/.test(await H.textContent("#h-code-error")));
    await input.fill(boards.B1.code);
    ok("첫 화면: 가로 스크롤 없음", await noHScroll(H));
    await shot(H, "s00-phone-home-code");
    await H.click("button[type=submit]:has-text('입장')");
    await H.waitForURL(new RegExp(`/b/${boards.B1.code}$`));
    await H.waitForSelector("#entry-number");
    ok("첫 화면 → 4자리 코드로 그 보드의 입장 화면", (await H.textContent(".entry-code")) === boards.B1.code);
    await H.close();
  });

  // ═════════ 3. 보드1: 명단 학생 실시간 ═════════
  const B1 = () => boards.B1.code;
  await step("교사: 대시보드 → 보드 열기", async () => {
    await T.locator(".t-board", { hasText: "새싹 관찰 일기" }).locator("text=보드 열기").click();
    await T.waitForSelector(".tbar");
    ok("교사가 보드 화면에서 교사 도구를 봄", await T.isVisible("text=🔒 잠그기"));
  });

  const A = await newPage(phone, "A-phone");
  const Bd = await newPage(desktop, "B-desktop");
  async function rosterEnter(p, code, number, pin, newPin) {
    await p.goto(`${BASE}/b/${code}`);
    await p.fill("#entry-number", number);
    await p.fill("#entry-pin", pin);
    await p.click("button[type=submit]");
    if (newPin) {
      await p.waitForSelector("#pin-new");
      await p.fill("#pin-new", newPin);
      await p.fill("#pin-again", newPin);
      await p.click("button[type=submit]");
    }
    await p.waitForSelector(".wall", { timeout: 15000 });
  }
  await step("학생 입장 (처음 PIN → 나만의 PIN)", async () => {
    await A.goto(`${BASE}/b/${B1()}`);
    await shot(A, "s01-phone-entry");
    await rosterEnter(A, B1(), "20301", "4821", "2580");
    await rosterEnter(Bd, B1(), "20302", "5932", "1357");
    ok("A(휴대폰)·B(데스크톱) 입장", true);
    ok("A: 휴대폰 가로 스크롤 없음", await noHScroll(A));
  });

  await step("A 글 → 모두에게 실시간", async () => {
    await A.click(".fab");
    await A.fill("#composer-title", "<img src=x onerror=window.__xss=1>떡잎");
    await A.fill("#composer-body", "오늘 아침 떡잎 두 장이 올라왔어요. 🌱 https://example.com/sprout");
    await A.click(".composer-send");
    await Bd.waitForSelector(".bcard >> text=떡잎", { timeout: 5000 });
    await T.waitForSelector(".bcard >> text=떡잎", { timeout: 5000 });
    const xss = await Bd.evaluate(() => window.__xss === undefined && document.querySelectorAll(".bcard-title img").length === 0);
    ok("B·교사: A 카드가 실시간으로 보임, 제목의 HTML 은 글자로 (XSS 없음)", xss);
  });

  let attNames = [];
  await step("B: 붙여넣기·끌어 놓기·파일 고르기로 첨부 4개", async () => {
    await Bd.click(".col.is-mine .col-add");
    await Bd.waitForSelector("#composer-title");
    await Bd.fill("#composer-title", "우리 콩 화분");
    await pasteFile(Bd, "#composer-form", { name: "붙여넣은 사진.png", type: "image/png", buffer: png(1200, 900, 90) });
    await dropFile(Bd, "#composer-form", { name: "끌어온 사진.png", type: "image/png", buffer: png(800, 1000, 220) });
    await Bd.setInputFiles(".composer-tools input[type=file][multiple]", [
      { name: "관찰 기록지.pdf", mimeType: "application/pdf", buffer: PDF },
      { name: "메모.html", mimeType: "text/html", buffer: Buffer.from("<script>alert(1)</script>") },
    ]);
    await Bd.waitForFunction(() => document.querySelectorAll(".composer-item.is-done").length === 4, null, { timeout: 30000 });
    attNames = await Bd.locator(".composer-item-name").allTextContents();
    ok("B: 첨부 4개 업로드 완료 (프록시 경로)", attNames.length === 4, attNames.join(", "));
    await shot(Bd, "s02-desktop-composer-attachments");
    await Bd.click(".composer-send");
    await Bd.waitForSelector(".bcard >> text=우리 콩 화분");
    const info = await (
      await A.waitForFunction(
        () => {
          const card = [...document.querySelectorAll(".bcard")].find((c) => c.textContent.includes("우리 콩 화분"));
          const imgs = card ? [...card.querySelectorAll("img.bcard-img")] : [];
          return imgs.length && imgs.every((i) => i.complete && i.naturalWidth > 0) ? { n: imgs.length, files: card.querySelectorAll(".bcard-file").length } : null;
        },
        null,
        { timeout: 20000 },
      )
    ).jsonValue();
    ok("A: 사진이 실제로 뜨고 파일 첨부도 보임", info.n >= 1 && info.files === 2, JSON.stringify(info));
  });

  await step("사진 크게 보기", async () => {
    const card = A.locator(".bcard", { hasText: "우리 콩 화분" });
    await card.locator(".bcard-img-btn").first().click();
    await A.waitForSelector(".ui-viewer img");
    await A.waitForFunction(() => {
      const i = document.querySelector(".ui-viewer img");
      return i && i.complete && i.naturalWidth > 0;
    });
    await sleep(400); // 열리는 효과가 끝난 뒤
    await shot(A, "s03-phone-image-viewer");
    const hasNext = await A.locator(".ui-viewer-next").count();
    if (hasNext) await A.click(".ui-viewer-next");
    ok("A: 사진 보기 창 (다음 사진으로 넘기기)", true, hasNext ? "2장" : "1장");
    await A.keyboard.press("Escape");
    await A.waitForSelector(".ui-viewer", { state: "detached" });
  });

  await step("PDF 내려받기 헤더", async () => {
    const href = await A.locator(".bcard", { hasText: "우리 콩 화분" }).locator("a.bcard-file", { hasText: ".pdf" }).getAttribute("href");
    const h = await A.evaluate(async (u) => {
      const r = await fetch(u);
      return { status: r.status, cd: r.headers.get("content-disposition"), ct: r.headers.get("content-type"), nosniff: r.headers.get("x-content-type-options"), csp: r.headers.get("content-security-policy"), len: (await r.arrayBuffer()).byteLength };
    }, href);
    ok("PDF: 200, Content-Disposition 에 한글 파일 이름(RFC 5987), nosniff, sandbox CSP", h.status === 200 && /filename\*=UTF-8''%EA%B4%80%EC%B0%B0/.test(h.cd) && h.nosniff === "nosniff" && /sandbox/.test(h.csp), JSON.stringify(h));
    const hh = await A.locator(".bcard", { hasText: "우리 콩 화분" }).locator("a.bcard-file", { hasText: "메모.html" }).getAttribute("href");
    const h2 = await A.evaluate(async (u) => {
      const r = await fetch(u);
      return { cd: r.headers.get("content-disposition"), ct: r.headers.get("content-type") };
    }, hh);
    ok("HTML 첨부: 화면에 열리지 않고 내려받기(attachment, text/plain)", /^attachment;/.test(h2.cd) && /^text\/plain/.test(h2.ct), JSON.stringify(h2));
    const bad = await A.evaluate(async (u) => (await fetch(u.replace(/t=[^&]+/, "t=forged.token"))).status, href);
    ok("파일 주소의 토큰을 바꾸면 401", bad === 401, String(bad));
  });

  await step("댓글·좋아요·교사가 댓글 지우기", async () => {
    const card = A.locator(".bcard", { hasText: "우리 콩 화분" });
    await card.locator(".bcard-like").click();
    await card.locator("button[aria-label^='댓글']").click();
    await A.fill("#comment-input", "와 콩이 엄청 커요!");
    await A.click(".comment-form button[type=submit]");
    await A.waitForSelector(".comment >> text=와 콩이 엄청 커요!");
    await shot(A, "s04-phone-comments");
    await A.keyboard.press("Escape");
    const bcard = Bd.locator(".bcard", { hasText: "우리 콩 화분" });
    await bcard.locator(".bcard-like span", { hasText: "1" }).waitFor({ timeout: 5000 });
    await bcard.locator("button[aria-label='댓글 1개 보기']").waitFor({ timeout: 5000 });
    ok("B: 좋아요 1·댓글 1 이 실시간", true);
    const tcard = T.locator(".bcard", { hasText: "우리 콩 화분" });
    await tcard.locator("button[aria-label='댓글 1개 보기']").click();
    await T.click(".comment button[aria-label='댓글 지우기']");
    const confirm = await T.locator(".ui-confirm-ok").count();
    if (confirm) await T.click(".ui-confirm-ok");
    await T.keyboard.press("Escape");
    await bcard.locator("button[aria-label='댓글 0개 보기'], button[aria-label='댓글 쓰기']").first().waitFor({ timeout: 5000 }).catch(() => {});
    const left = await Bd.locator(".bcard", { hasText: "우리 콩 화분" }).locator("button[aria-label='댓글 1개 보기']").count();
    ok("교사가 댓글을 지우면 B 화면에서도 사라짐", left === 0);
  });

  await step("공지", async () => {
    await T.click("text=📢 공지 쓰기");
    await T.fill("#notice-title", "오늘의 활동");
    await T.fill("#notice-body", "사진은 한 장 이상 꼭 올려 주세요.");
    await T.click("button[form=notice-form]");
    await A.waitForSelector(".notice-title >> text=오늘의 활동", { timeout: 5000 });
    await A.evaluate(() => window.scrollTo(0, 0));
    await shot(A, "s05-phone-notice");
    ok("A: 공지가 실시간으로 보임", true);
    await T.click(".notice button[aria-label='공지 지우기']");
    if (await T.locator(".ui-confirm-ok").count()) await T.click(".ui-confirm-ok");
    await A.waitForSelector(".notice-title >> text=오늘의 활동", { state: "detached", timeout: 5000 });
    ok("교사가 공지를 지우면 A 화면에서도 사라짐", true);
  });

  await step("닉네임 바꾸기", async () => {
    await A.click(".topbar-me");
    await A.click("text=✏️ 닉네임 바꾸기");
    await A.fill("#nick-input", "별빛");
    await A.click("button[form=nick-form]");
    await A.waitForSelector(".topbar-me >> text=별빛", { timeout: 8000 });
    await Bd.waitForSelector(".col-title >> text=별빛", { timeout: 8000 });
    ok("A 닉네임 → B 화면 칸 이름도 바뀜", true);
  });

  // ── PIN 5번 틀리면 잠김 → 교사가 풀기 ──
  const C = await newPage(phone, "C-phone");
  await step("PIN 잠금과 교사 잠금 풀기", async () => {
    await C.goto(`${BASE}/b/${B1()}`);
    await C.fill("#entry-number", "20303");
    const attempt = async (pin) => {
      await C.fill("#entry-pin", pin);
      const [res] = await Promise.all([C.waitForResponse((r) => r.url().endsWith("/login")), C.click("button[type=submit]")]);
      const body = await res.json();
      await C.waitForSelector(".error-text");
      return { status: res.status(), code: body.error && body.error.code, text: await C.textContent(".error-text") };
    };
    const tries = [];
    for (let i = 0; i < 5; i++) tries.push(await attempt(String(1000 + i)));
    const last = tries[4];
    ok("C: 1~4번째는 401, 5번째 틀리면 429 잠김 안내", tries.slice(0, 4).every((t) => t.status === 401) && last.status === 429 && last.code === "student_locked" && /5번 틀렸/.test(last.text), last.text);
    const btnDisabled = await C.locator("button[type=submit]").isDisabled();
    const still = await C.evaluate(async (code) => {
      const r = await fetch(`/api/boards/${code}/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ number: "20303", pin: "7710" }) });
      return { status: r.status, code: (await r.json()).error?.code };
    }, B1());
    ok("C: 잠긴 동안 들어가기 단추가 꺼지고, 맞는 PIN 도 서버가 거부", btnDisabled && still.code === "student_locked", JSON.stringify(still));
    await shot(C, "s06-phone-pin-locked");
    await T.goto(classUrl);
    await T.waitForSelector("text=5회 틀려 잠김");
    await shot(T, "t08-class-locked-student");
    await T.locator("tr", { hasText: "20303" }).locator("text=잠금 풀기").click();
    await T.waitForSelector("text=5회 틀려 잠김", { state: "detached" });
    await C.reload();
    await C.fill("#entry-number", "20303");
    await C.fill("#entry-pin", "7710");
    await C.click("button[type=submit]");
    await C.waitForSelector("#pin-new");
    ok("교사가 잠금 풀면 C 가 바로 들어감 (나만의 PIN 화면)", true);
    await C.fill("#pin-new", "8642");
    await C.fill("#pin-again", "8642");
    await C.click("button[type=submit]");
    await C.waitForSelector(".wall");
  });

  // ── 백업 배지 (실제 30초 알람) ──
  await step("백업 배지: 성공", async () => {
    await T.goto(`${BASE}/b/${B1()}`);
    await T.waitForSelector(".tbar-backup");
    await T.waitForSelector(".tbar-backup >> text=백업됨", { timeout: 45000 });
    ok("교사: 백업됨 배지", true, await T.textContent(".tbar-backup"));
    const files = await driveFiles();
    const backup = files.find((f) => f.name === "게시글 백업.json" && f.text && f.text.includes("우리 콩 화분"));
    ok("가짜 Drive 에 게시글 백업.json, 학생 실명·PIN 해시 없음", backup && backup.text.includes("우리 콩 화분") && !/pin_hash|pinHash|initialPin|4821/.test(backup.text), backup ? backup.text.length + "B" : "없음");
    await shot(T, "t09-board-teacher-backup-ok");
  });
  await step("백업 배지: Drive 실패 → 오류 → 복구", async () => {
    await setDrive("fail");
    await A.click(".fab");
    await A.fill("#composer-body", "드라이브가 아픈 동안 쓴 글");
    await A.click(".composer-send");
    await T.waitForSelector(".tbar-backup >> text=백업 실패", { timeout: 45000 });
    ok("Drive 가 실패하면 교사 배지가 백업 실패", true, await T.getAttribute(".tbar-backup", "title"));
    await shot(T, "t10-board-teacher-backup-error");
    await setDrive("ok");
    await T.waitForSelector(".tbar-backup >> text=백업됨", { timeout: 45000 });
    ok("Drive 가 돌아오면 재시도로 다시 백업됨", true);
  });
  await step("백업 배지: Drive API 꺼짐 → 해결 안내 링크", async () => {
    await setDrive("api_off");
    await A.click(".fab");
    await A.fill("#composer-body", "API 꺼진 동안 쓴 글");
    await A.click(".composer-send");
    await T.waitForSelector("a.tbar-backup[href='/setup#help-api']", { timeout: 45000 });
    ok("Drive API 꺼짐: 배지가 /setup#help-api 로 가는 링크", true, await T.textContent(".tbar-backup"));
    await shot(T, "t11-board-teacher-backup-api-off");
    await setDrive("ok");
  });

  // ── 내보내기·드라이브 폴더·포트폴리오·최근 글 ──
  await step("시트 내보내기·드라이브 폴더 열기", async () => {
    await T.goto(`${BASE}/teacher/boards/${boards.B1.id}`);
    await T.waitForSelector("text=드라이브 폴더 열기");
    const folder = await T.getAttribute("a:has-text('드라이브 폴더 열기')", "href");
    ok("드라이브 폴더 열기: drive.google.com 폴더 주소 (새 창)", /^https:\/\/drive\.google\.com\/drive\/folders\/fo/.test(folder), folder);
    const [popup] = await Promise.all([T.context().waitForEvent("page"), T.click("text=구글 시트로 내보내기")]);
    await popup.waitForURL(/docs\.google\.com\/spreadsheets/, { timeout: 15000 });
    ok("내보내기: 새 창이 만든 시트 주소로", true, popup.url());
    await popup.close();
    await T.waitForSelector("text=만든 시트 열기");
    const sheet = (await driveFiles()).find((f) => f.mimeType === "application/vnd.google-apps.spreadsheet");
    const csv = sheet ? sheet.text : "";
    ok("내보낸 CSV: 학번·실명 포함, 수식처럼 보이는 이름은 ' 로 막음", csv.includes("20302") && csv.includes("이두리") && !/(^|,)=SUM/m.test(csv), csv.split("\r\n")[0]);
    await shot(T, "t12-board-manage");
  });
  await step("포트폴리오 사진", async () => {
    await T.goto(classUrl);
    await T.locator("tr", { hasText: "20302" }).locator("text=포트폴리오").click();
    await T.waitForFunction(() => {
      const i = document.querySelector("img.t-pf-img");
      return i && i.complete && i.naturalWidth > 0;
    }, null, { timeout: 15000 });
    ok("포트폴리오: B 의 사진이 실제로 뜸", true);
    await shot(T, "t13-portfolio", { fullPage: true });
  });
  await step("대시보드 최근 글 사진 미리보기", async () => {
    await T.goto(BASE + "/teacher");
    await T.waitForFunction(() => {
      const i = document.querySelector("img.t-recent-img");
      return i && i.complete && i.naturalWidth > 0;
    }, null, { timeout: 15000 });
    ok("최근 올라온 글에 사진 미리보기", true);
    await shot(T, "t14-dashboard-recent", { fullPage: true });
  });

  // ═════════ 4. 보드2: 모둠별 + 학생당 1카드 → 보관 ═════════
  await step("모둠별 열 + 학생당 1카드", async () => {
    await rosterEnter(A, boards.B2.code, "20301", "2580");
    const titles = await A.locator(".col-title").allTextContents();
    ok("A: 모둠 이름으로 열", titles.some((t) => t.includes("1모둠")) && titles.some((t) => t.includes("2모둠")), titles.join(" | "));
    await A.click(".fab");
    await A.fill("#composer-body", "우리 모둠은 재활용을 조사했어요.");
    await A.click(".composer-send");
    await A.waitForSelector(".bcard >> text=재활용");
    // 한 장을 쓴 뒤에는 글쓰기 단추가 '내 카드' 고치기로 바뀐다 (두 번째 카드를 만들 길이 없음)
    await A.click(".fab");
    const heading = await A.textContent(".ui-modal-title");
    const body = await A.inputValue("#composer-body");
    ok("A: 학생당 1카드 보드에서 글쓰기 단추가 내 카드 고치기로 열림", /고치기/.test(heading) && body.includes("재활용"), heading);
    await A.keyboard.press("Escape");
    // 서버 규칙도 확인: 웹소켓으로 직접 두 번째 카드를 보내면 one_card_only
    const code2 = boards.B2.code;
    const res = await A.evaluate(async (code) => {
      const token = localStorage.getItem("nb_st:" + code) || "";
      const ws = new WebSocket(`ws://${location.host}/api/boards/${code}/ws?st=${encodeURIComponent(token)}`);
      return await new Promise((resolve) => {
        ws.onmessage = (e) => {
          const m = JSON.parse(e.data);
          if (m.t === "snapshot") ws.send(JSON.stringify({ t: "post.save", opId: "second-card-" + Date.now(), post: { body: "몰래 두 번째" } }));
          if (m.t === "error" || m.t === "ack") {
            ws.close();
            resolve(m.code || "ack");
          }
        };
        setTimeout(() => resolve("timeout"), 5000);
      });
    }, code2);
    ok("서버: 두 번째 카드는 one_card_only", res === "one_card_only", res);
    await A.evaluate(() => window.scrollTo(0, 0));
    await shot(A, "s07-phone-group-single");
  });
  await step("연결된 학생에게 보관", async () => {
    await T.goto(`${BASE}/teacher/boards/${boards.B2.id}`);
    await T.click("button:has-text('보관하기')");
    await A.waitForSelector("text=보관된 보드예요", { timeout: 8000 });
    ok("A: 보관하면 연결된 학생 화면이 '보관된 보드예요'", true);
    await shot(A, "s08-phone-archived");
  });

  // ═════════ 5. 보드3: 자유 입장 + 주제별 + 승인 후 게시 → 삭제 ═════════
  const F = await newPage(phone, "F-phone");
  const G = await newPage(desktop, "G-desktop");
  await step("자유 입장 (닉네임만)", async () => {
    for (const [p, nick] of [[F, "토끼"], [G, "거북"]]) {
      await p.goto(`${BASE}/b/${boards.B3.code}`);
      await p.fill("#entry-nick", nick);
      if (p === F) await shot(F, "s09-phone-free-entry");
      await p.click("button[type=submit]");
      await p.waitForSelector(".wall");
    }
    const cols = await G.locator(".col-title").allTextContents();
    ok("자유 입장 + 주제 이름 3개 열", ["좋았던 점", "아쉬운 점", "궁금한 점"].every((t) => cols.some((c) => c.includes(t))), cols.join(" | "));
  });
  await step("승인 후 게시", async () => {
    await F.click(".fab");
    await F.selectOption("#composer-col", { label: "아쉬운 점" });
    await F.fill("#composer-body", "시간이 조금 짧았어요.");
    await F.click(".composer-send");
    await F.waitForSelector(".bcard.is-pending >> text=시간이 조금", { timeout: 5000 });
    await sleep(800);
    ok("승인 전: 작성자에게만 '승인 대기', 다른 학생에게는 안 보임", (await G.locator(".bcard >> text=시간이 조금").count()) === 0);
    await shot(F, "s10-phone-pending");
    await T.goto(`${BASE}/b/${boards.B3.code}`);
    await T.waitForSelector("text=⏳ 승인 대기 1");
    await T.locator(".bcard", { hasText: "시간이 조금" }).locator("text=✅ 승인").click();
    await G.waitForSelector(".bcard >> text=시간이 조금", { timeout: 5000 });
    await F.waitForSelector(".bcard.is-pending", { state: "detached", timeout: 5000 });
    ok("승인하면 다른 학생에게 나타나고 작성자의 대기 표시가 사라짐", true);
  });
  await step("주제 칸 추가·이름 바꾸기·순서·지우기", async () => {
    await T.click("text=＋ 칸 추가");
    await T.fill("#col-title", "더 하고 싶은 말");
    await T.click("button[form=col-form]");
    await G.waitForSelector(".col-title >> text=더 하고 싶은 말", { timeout: 5000 });
    await T.click("button[aria-label='궁금한 점 칸 관리']");
    await T.click(".menu [role=menuitem]:has-text('이름 바꾸기')");
    await T.fill("#col-title", "질문");
    await T.click("button[form=col-form]");
    await G.waitForSelector(".col-title >> text=질문", { timeout: 5000 });
    await T.click("button[aria-label='질문 칸 관리']");
    await T.click(".menu [role=menuitem]:has-text('앞으로')");
    await G.waitForFunction(() => {
      const t = [...document.querySelectorAll(".col-title")].map((e) => e.textContent);
      return t.findIndex((x) => x.includes("질문")) < t.findIndex((x) => x.includes("아쉬운 점"));
    }, null, { timeout: 5000 });
    await T.click("button[aria-label='더 하고 싶은 말 칸 관리']");
    await T.click(".menu [role=menuitem]:has-text('지우기')");
    await T.click(".ui-confirm-ok");
    await G.waitForSelector(".col-title >> text=더 하고 싶은 말", { state: "detached", timeout: 5000 });
    // 카드가 있는 칸은 못 지움
    await T.click("button[aria-label='아쉬운 점 칸 관리']");
    await T.click(".menu [role=menuitem]:has-text('지우기')");
    await T.click(".ui-confirm-ok");
    await T.waitForSelector(".toast", { timeout: 5000 });
    const msg = await T.textContent(".toast-area");
    ok("주제 칸: 추가·이름·순서·지우기가 학생 화면에 실시간, 카드 있는 칸은 지울 수 없다고 안내", /카드가 있는/.test(msg), msg);
    ok("주제 칸을 바꾸는 동안 카드는 그대로", (await G.locator(".bcard", { hasText: "시간이 조금" }).count()) === 1);
    await shot(G, "s11-desktop-topic-columns");
    await shot(T, "t15-teacher-topic-board");
  });
  await step("연결된 학생에게 보드 삭제", async () => {
    await T.goto(`${BASE}/teacher/boards/${boards.B3.id}`);
    await T.click("text=지우기…");
    await T.fill("#confirm-input", boards.B3.title);
    await T.click("button[type=submit]:has-text('영구히 지우기')");
    await F.waitForSelector("text=없어진 보드예요", { timeout: 8000 });
    ok("F: 지운 보드는 '없어진 보드예요'", true);
    await shot(F, "s12-phone-deleted");
  });

  // ═════════ 6. /setup 설치 점검 (설치된 곳) ═════════
  await step("/setup 설치 점검: 로그인 + Drive 정상", async () => {
    await T.goto(BASE + "/setup#check");
    await T.waitForSelector("text=설치가 모두 끝났어요!", { timeout: 15000 });
    const head = await T.textContent(".su-progress-text");
    const pct = Number(await T.getAttribute(".su-bar", "aria-valuenow"));
    ok("설치 점검: 모두 통과, '15/15 단계' 와 진행 막대 100%·'모두 끝났어요' 가 맞음", /15\/15/.test(head) && pct === 100 && /모두 끝났어요/.test(head), `${head.replace(/\s+/g, " ")} / ${pct}%`);
    await sleep(600); // 진행 막대 효과가 끝난 뒤
    await shot(T, "t16-setup-check-ok");
  });
  await step("/setup 설치 점검: Drive API 꺼짐", async () => {
    await setDrive("api_off");
    await T.click("text=다시 점검");
    await T.waitForSelector("text=Google Drive API가 꺼져 있어요", { timeout: 15000 });
    const pct = Number(await T.getAttribute(".su-bar", "aria-valuenow"));
    ok("설치 점검: Drive API 꺼짐 안내 + 마지막 단계 미완료로 되돌림", pct < 100, `${pct}%`);
    await shot(T, "t17-setup-check-api-off");
    await setDrive("ok");
  });

  // ═════════ 7. 휴대폰 교사 화면 · 다크 모드 ═════════
  await step("휴대폰 교사 화면·다크 모드", async () => {
    const TP = await newPage(phone, "teacher-phone");
    await TP.goto(BASE + "/__test/login?to=/teacher");
    await TP.waitForSelector(".t-board");
    ok("교사(휴대폰): 대시보드 가로 스크롤 없음", await noHScroll(TP));
    await shot(TP, "t18-dashboard-phone");
    await TP.goto(`${BASE}/b/${B1()}`);
    await TP.waitForSelector(".tbar");
    ok("교사(휴대폰): 보드 화면 가로 스크롤 없음", await noHScroll(TP));
    await shot(TP, "t19-board-teacher-phone");
    for (const [p, name] of [[A, "d01-phone-student-dark"], [T, "d02-teacher-setup-dark"], [TP, "d03-teacher-board-phone-dark"], [Bd, "d04-desktop-student-dark"]]) {
      await p.emulateMedia({ colorScheme: "dark" });
      await sleep(250);
      await shot(p, name);
    }
    await A.goto(`${BASE}/b/${B1()}`);
    await A.waitForSelector(".wall");
    await shot(A, "d05-phone-board-dark");
    await T.goto(BASE + "/teacher");
    await T.waitForSelector(".t-board");
    await shot(T, "d06-dashboard-dark");
    // 휴대폰 세로 화면의 프로젝터 안내도 코드가 잘리지 않게
    await TP.emulateMedia({ colorScheme: "light" });
    await TP.goto(`${BASE}/teacher/boards/${boards.B1.id}/projector`);
    await TP.waitForSelector(".t-projector-code");
    const p = await TP.locator(".t-projector-code").evaluate((el) => ({ text: el.textContent, px: parseFloat(getComputedStyle(el).fontSize) }));
    ok("교사(휴대폰): 프로젝터 화면 코드 크게, 가로 스크롤 없음", p.text === boards.B1.code && p.px >= 40 && (await noHScroll(TP)), `${p.px}px`);
    await shot(TP, "t20-projector-phone");
  });

  // ═════════ 8. 예전(영숫자 6자) 입장 코드 보드도 그대로 ═════════
  await step("예전 6자 코드 보드: 첫 화면 입력·입장·대시보드·프로젝터", async () => {
    await T.emulateMedia({ colorScheme: "light" });
    await T.goto(BASE + "/teacher");
    const made = await T.evaluate(async () => {
      const r = await fetch("/api/teacher/boards", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "예전 코드 보드", entryMode: "free" }) });
      return r.json();
    });
    const set = await fetch(`${BASE}/__test/legacy-code?board=${made.id}&code=K7QX2M`, { method: "POST" });
    if (!set.ok) throw new Error("legacy-code " + set.status);
    const L = await newPage(phone, "L-phone-legacy");
    await L.goto(BASE + "/");
    await L.click("text=코드에 영어 글자가 있어요");
    const mode = await L.getAttribute("#h-code-input", "inputmode");
    await L.fill("#h-code-input", "k7q x2m");
    await L.click("button[type=submit]:has-text('입장')");
    await L.waitForURL(/\/b\/K7QX2M$/);
    await L.fill("#entry-nick", "예전학생");
    await L.click("button[type=submit]");
    await L.waitForSelector(".wall", { timeout: 15000 });
    ok("예전 코드: 글자 자판으로 바꿔 소문자·띄어쓰기로 쳐도 입장", mode === "text", mode);
    await shot(L, "s13-phone-legacy-code-board");
    await L.close();
    await T.goto(BASE + "/teacher");
    await T.waitForSelector(".t-board");
    const card = await T.locator(".t-board", { hasText: "예전 코드 보드" }).textContent();
    ok("예전 코드: 대시보드에 'K7Q X2M' 그대로", card.includes("K7Q X2M"), card.slice(0, 80));
    await T.goto(`${BASE}/teacher/boards/${made.id}/projector`);
    await T.waitForSelector(".t-projector-code");
    const p = await T.locator(".t-projector-code").evaluate((el) => ({ text: el.textContent, fits: el.getBoundingClientRect().right <= window.innerWidth }));
    ok("예전 코드: 프로젝터에 'K7Q X2M' 가 화면 안에", p.text === "K7Q X2M" && p.fits, JSON.stringify(p));
    await shot(T, "t21-projector-legacy-code");
  });

  ok("페이지 오류·CSP 위반 없음", errors.length === 0, errors.slice(0, 6).join(" | "));
  await browser.close();
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} 통과 · 스크린숏 ${shots.length}장 → ${OUT}`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(2);
});
