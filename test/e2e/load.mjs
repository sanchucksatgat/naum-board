/**
 * 실제 소켓 부하 시험 (npm run e2e:load, 또는 e2e:serve 를 띄운 뒤 BASE=http://localhost:8791 node test/e2e/load.mjs).
 * 한 보드에 학생 50명 + 교사 1명이 실제 웹소켓으로 붙어 쓰고, 모든 클라이언트의 상태가 같아지는지,
 * 변경분이 빠지거나 겹치지 않는지, 지연(p50/p95), 카드 300장 스냅숏 크기·시간, 재접속 폭주, 속도 제한, 같은 IP 50명 입장을 잰다.
 * 끝에 무료 요금제 계산에 쓸 메시지 수를 낸다. 실패하면 종료 코드 1.
 */
const BASE = process.env.BASE || "http://localhost:8791";
const WS_BASE = BASE.replace(/^http/, "ws");
const N = Number(process.env.STUDENTS || 50);

const results = [];
const ok = (name, cond, extra = "") => {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (arr, p) => {
  if (!arr.length) return NaN;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
let opSeq = 0;
const opId = () => `ld_${Date.now().toString(36)}_${(++opSeq).toString(36)}`;

// 요금 계산용 계수
const count = { http: 0, wsConnect: 0, wsIn: 0, wsOut: 0, wsOutBytes: 0 };

async function http(path, init = {}, cookie) {
  count.http++;
  const headers = { "content-type": "application/json", origin: BASE, ...(init.headers || {}) };
  if (cookie) headers.cookie = cookie;
  const r = await fetch(BASE + path, { ...init, headers, redirect: "manual" });
  const text = await r.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: r.status, body, headers: r.headers };
}

/** 받은 메시지로 화면 상태를 똑같이 따라 만드는 작은 클라이언트 (web/lib/realtime-state 와 같은 규칙) */
class Client {
  constructor(name, { token, cookie }) {
    this.name = name;
    this.token = token;
    this.cookie = cookie;
    this.state = null;
    this.acks = new Map();
    this.errors = [];
    this.seen = new Map(); // postId → 처음 받은 시각
    this.dupUpserts = 0;
    this.msgs = 0;
  }
  connect() {
    const url = `${WS_BASE}/api/boards/${this.code}/ws${this.token ? "?st=" + encodeURIComponent(this.token) : ""}`;
    const t0 = performance.now();
    count.wsConnect++;
    this.ws = new WebSocket(url, this.cookie ? { headers: { cookie: this.cookie, origin: BASE } } : undefined);
    this.closed = new Promise((r) => (this.ws.onclose = (e) => r(e.code)));
    return new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error(this.name + " snapshot timeout")), 20000);
      this.ws.onerror = () => reject(new Error(this.name + " ws error"));
      this.ws.onmessage = (ev) => {
        this.msgs++;
        count.wsOut++;
        count.wsOutBytes += ev.data.length;
        const m = JSON.parse(ev.data);
        this.onMessage(m, ev.data.length);
        if (m.t === "snapshot" && !this.ready) {
          this.ready = true;
          this.snapshotMs = performance.now() - t0;
          this.snapshotBytes = ev.data.length;
          clearTimeout(to);
          resolve();
        }
      };
    });
  }
  onMessage(m) {
    const now = performance.now();
    if (m.t === "snapshot") {
      const s = m.snapshot;
      this.state = { posts: new Map(s.posts.map((p) => [p.id, p])), notices: s.notices.length };
      for (const p of s.posts) if (!this.seen.has(p.id)) this.seen.set(p.id, now);
      this.snapshot = s;
      return;
    }
    if (!this.state) return;
    const P = this.state.posts;
    switch (m.t) {
      case "post.upsert":
        if (!this.seen.has(m.post.id)) this.seen.set(m.post.id, now);
        P.set(m.post.id, m.post);
        break;
      case "post.remove":
        P.delete(m.postId);
        break;
      case "comment.add": {
        const p = P.get(m.comment.postId);
        if (p && !p.comments.some((c) => c.id === m.comment.id)) p.comments.push(m.comment);
        else if (p) this.dupUpserts++;
        break;
      }
      case "comment.remove": {
        const p = P.get(m.postId);
        if (p) p.comments = p.comments.filter((c) => c.id !== m.commentId);
        break;
      }
      case "like.set": {
        const p = P.get(m.postId);
        if (p) {
          p.likeCount = m.count;
          p.likedByMe = m.liked;
        }
        break;
      }
      case "ack":
        this.acks.get(m.opId)?.resolve({ ...m, at: now });
        break;
      case "error":
        this.errors.push(m);
        if (m.opId) this.acks.get(m.opId)?.resolve({ ...m, at: now });
        break;
    }
  }
  send(msg) {
    const id = opId();
    const p = new Promise((resolve) => this.acks.set(id, { resolve }));
    const sentAt = performance.now();
    count.wsIn++;
    this.ws.send(JSON.stringify({ ...msg, opId: id }));
    return p.then((r) => ({ ...r, sentAt }));
  }
  /** 서버에 새 스냅숏을 받아 지금 상태와 비교할 수 있게 */
  async fresh() {
    const before = this.snapshot;
    count.wsIn++;
    this.ws.send(JSON.stringify({ t: "sync" }));
    const t0 = Date.now();
    while (this.snapshot === before && Date.now() - t0 < 10000) await sleep(20);
    return this.snapshot;
  }
  view() {
    const out = {};
    for (const [id, p] of this.state.posts) out[id] = { status: p.status, likes: p.likeCount, comments: p.comments.map((c) => c.id).sort().join(","), title: p.title, body: p.body };
    return out;
  }
}

const sig = (v) => JSON.stringify(Object.keys(v).sort().map((k) => [k, v[k]]));

(async () => {
  // ── 교사 ──
  const login = await fetch(BASE + "/__test/login?to=/teacher", { redirect: "manual" });
  count.http++;
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const students = Array.from({ length: N }, (_, i) => ({ number: String(30100 + i + 1), name: `학생${i + 1}`, pin: String(4000 + i), group: `${(i % 6) + 1}모둠` }));
  const cls = await http("/api/teacher/classes", { method: "POST", body: JSON.stringify({ name: "부하 시험 반", students }) }, cookie);
  const board = await http("/api/teacher/boards", { method: "POST", body: JSON.stringify({ title: "부하 시험 보드", classId: cls.body.class.id, entryMode: "roster", columnMode: "student" }) }, cookie);
  const code = board.body.code;
  ok("반 50명 + 보드 만들기 (입장 코드 숫자 4자리)", cls.status === 201 && board.status === 201 && /^[0-9]{4}$/.test(code), code);

  // ── 같은 IP(NAT) 에서 50명이 1분 안에 처음 입장 (+ 나만의 PIN 으로 바꾸기), 그중 10명은 한 번씩 틀림 ──
  const t0 = performance.now();
  let throttled = 0;
  const tokens = await Promise.all(
    students.map(async (s, i) => {
      await sleep(Math.random() * 20000); // 20초 동안 흩어져서
      if (i % 5 === 0) {
        const bad = await http(`/api/boards/${code}/login`, { method: "POST", body: JSON.stringify({ number: s.number, pin: "9999" }) });
        if (bad.status === 429) throttled++;
      }
      const r = await http(`/api/boards/${code}/login`, { method: "POST", body: JSON.stringify({ number: s.number, pin: s.pin }) });
      if (r.status !== 200) {
        if (r.status === 429) throttled++;
        throw new Error(`login ${s.number} ${r.status} ${JSON.stringify(r.body)}`);
      }
      // 처음 PIN 으로 바로 들어가지만, 부하 시험에서는 모두 나만의 PIN 으로 바꿔 본다 (명단 사본 갱신까지)
      const p = await http(`/api/boards/${code}/pin`, {
        method: "POST",
        headers: { authorization: `Bearer ${r.body.token}` },
        body: JSON.stringify({ currentPin: s.pin, newPin: String(6000 + i) }),
      });
      if (p.status !== 200) throw new Error(`pin ${s.number} ${p.status}`);
      return p.body.token;
    }),
  ).catch((e) => {
    ok("같은 IP 50명 처음 입장", false, String(e.message));
    return null;
  });
  if (!tokens) process.exit(1);
  ok("같은 IP 에서 50명 첫 입장(+10명 한 번 틀림)이 막히지 않음", throttled === 0, `${((performance.now() - t0) / 1000).toFixed(1)}s, 429=${throttled}`);

  // ── 동시 접속 ──
  const clients = tokens.map((token, i) => Object.assign(new Client("s" + (i + 1), { token }), { code }));
  const teacher = Object.assign(new Client("teacher", { cookie }), { code });
  const tj = performance.now();
  await Promise.all([teacher, ...clients].map((c) => c.connect()));
  const joinMs = performance.now() - tj;
  ok("51명이 동시에 접속해 스냅숏을 받음", true, `전체 ${joinMs.toFixed(0)}ms, 1인 p95 ${pct(clients.map((c) => c.snapshotMs), 95).toFixed(0)}ms`);

  // ── 30명이 같은 5초 안에 글 올리기 (속도 제한에 안 걸려야) ──
  const sends = [];
  for (let i = 0; i < 30; i++) {
    const c = clients[i];
    sends.push(sleep(Math.random() * 5000).then(() => c.send({ t: "post.save", post: { title: `${c.name} 생각`, body: `수업 시간에 쓴 글 ${i}` } })));
  }
  const acks = await Promise.all(sends);
  const rl = acks.filter((a) => a.t === "error");
  ok("30명이 5초 안에 글 올림: 속도 제한·오류 없음", rl.length === 0, rl.map((x) => x.code).join(","));

  // ── 모두 댓글·좋아요를 몰아서 ──
  await sleep(500);
  const postIds = [...teacher.state.posts.keys()];
  const burst = [];
  for (const c of clients) {
    for (let k = 0; k < 2; k++) burst.push(sleep(Math.random() * 4000).then(() => c.send({ t: "comment.add", postId: postIds[Math.floor(Math.random() * postIds.length)], body: `${c.name} 댓글 ${k}` })));
    const liked = new Set();
    for (let k = 0; k < 3; k++) {
      const pid = postIds[Math.floor(Math.random() * postIds.length)];
      if (liked.has(pid)) continue;
      liked.add(pid);
      burst.push(sleep(Math.random() * 4000).then(() => c.send({ t: "like.set", postId: pid, liked: true })));
    }
  }
  // 남은 20명도 글
  for (let i = 30; i < N; i++) burst.push(sleep(Math.random() * 3000).then(() => clients[i].send({ t: "post.save", post: { body: `늦게 쓴 글 ${i}` } })));
  const bAcks = await Promise.all(burst);
  const bErr = bAcks.filter((a) => a.t === "error");
  ok("댓글·좋아요·글이 몰려도 오류 없음", bErr.length === 0, `${bAcks.length}건, 오류 ${bErr.map((x) => x.code).join(",")}`);
  await sleep(1500);

  // ── 모두 같은 상태인가 (실시간으로 쌓은 상태 = 서버 스냅숏 = 다른 사람 상태) ──
  const views = [teacher, ...clients].map((c) => sig(c.view()));
  const allSame = views.every((v) => v === views[0]);
  const fresh = await Promise.all([teacher, ...clients].map((c) => c.fresh().then((s) => sig(Object.fromEntries(s.posts.map((p) => [p.id, { status: p.status, likes: p.likeCount, comments: p.comments.map((x) => x.id).sort().join(","), title: p.title, body: p.body }]))))));
  const matchesServer = fresh.every((f, i) => f === views[i]);
  ok("51개 클라이언트가 모두 같은 화면 상태, 서버 스냅숏과도 같음 (빠진·겹친 변경 없음)", allSame && matchesServer, `카드 ${teacher.state.posts.size}장, 댓글 중복 ${[teacher, ...clients].reduce((a, c) => a + c.dupUpserts, 0)}`);

  // ── 변경분 지연: 보낸 시각 → 다른 클라이언트가 그 카드를 처음 받은 시각 ──
  const lat = [];
  for (const a of acks) {
    const pid = a.result?.postId;
    if (!pid) continue;
    for (const c of clients) {
      const t = c.seen.get(pid);
      if (t !== undefined && t >= a.sentAt) lat.push(t - a.sentAt);
    }
  }
  const ackLat = [...acks, ...bAcks].map((a) => a.at - a.sentAt);
  ok("변경분 지연 측정", lat.length > 1000, `p50 ${pct(lat, 50).toFixed(0)}ms, p95 ${pct(lat, 95).toFixed(0)}ms, 최대 ${Math.max(...lat).toFixed(0)}ms (${lat.length}개) · ack p50 ${pct(ackLat, 50).toFixed(0)}ms p95 ${pct(ackLat, 95).toFixed(0)}ms`);

  // ── 카드 300장 → 스냅숏 크기·시간 ──
  const need = 300 - teacher.state.posts.size;
  const fill = [];
  for (let i = 0; i < need; i++) {
    const c = clients[i % clients.length];
    fill.push(sleep(Math.floor(i / clients.length) * 700 + Math.random() * 300).then(() => c.send({ t: "post.save", post: { title: `채우기 ${i}`, body: "관찰한 내용을 적어요. ".repeat(8) } })));
  }
  const fAcks = await Promise.all(fill);
  await sleep(1000); // 보낸 사람은 ack 전에 받지만, 다른 사람(교사)에게는 조금 뒤에 도착한다
  ok("카드 300장 채우기", fAcks.every((a) => a.t === "ack") && teacher.state.posts.size >= 300, `${teacher.state.posts.size}장, 오류 ${fAcks.filter((a) => a.t === "error").length}`);
  const probe = Object.assign(new Client("probe", { token: tokens[0] }), { code });
  await probe.connect();
  const probeT = Object.assign(new Client("probeT", { cookie }), { code });
  await probeT.connect();
  const dupAcks = fAcks.filter((a) => a.result?.duplicate).length;
  const uniq = new Set(fAcks.map((a) => a.result?.postId)).size;
  ok("카드 300장: 실시간 상태 = 새 접속 스냅숏", probeT.snapshot.posts.length === teacher.state.posts.size, `서버 ${probeT.snapshot.posts.length}장, 교사 실시간 ${teacher.state.posts.size}장, ack ${fAcks.length}개(고유 ${uniq}, 중복 ${dupAcks}), need ${need}`);
  ok("카드 300장 스냅숏", true, `학생 ${(probe.snapshotBytes / 1024).toFixed(0)}KB ${probe.snapshotMs.toFixed(0)}ms · 교사 ${(probeT.snapshotBytes / 1024).toFixed(0)}KB ${probeT.snapshotMs.toFixed(0)}ms`);
  probe.ws.close();
  probeT.ws.close();

  // ── 재접속 폭주: 모두 끊고 한꺼번에 다시 ──
  const before = sig(teacher.view());
  for (const c of [teacher, ...clients]) c.ws.close();
  await Promise.all([teacher, ...clients].map((c) => c.closed));
  for (const c of [teacher, ...clients]) c.ready = false;
  const tr = performance.now();
  await Promise.all([teacher, ...clients].map((c) => c.connect()));
  const stormMs = performance.now() - tr;
  const after = [teacher, ...clients].map((c) => sig(c.view()));
  ok("재접속 폭주(51개 동시): 모두 다시 붙고 상태가 끊기기 전과 같음", after.every((v) => v === before), `${stormMs.toFixed(0)}ms, 1인 p95 ${pct(clients.map((c) => c.snapshotMs), 95).toFixed(0)}ms`);

  // ── 속도 제한이 진짜 남용은 막는지 (한 학생이 1초에 40개) ──
  const spam = await Promise.all(Array.from({ length: 40 }, () => clients[0].send({ t: "like.set", postId: postIds[0], liked: Math.random() > 0.5 })));
  ok("한 학생이 1초에 40개 보내면 일부는 rate_limited", spam.some((a) => a.code === "rate_limited"), `${spam.filter((a) => a.code === "rate_limited").length}/40 거부`);

  for (const c of [teacher, ...clients]) c.ws.close();
  const failed = results.filter((r) => !r.pass);
  console.log("\n요금 계산용 메시지 수:", JSON.stringify(count));
  console.log(`${results.length - failed.length}/${results.length} 통과`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(2);
});
