import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { DEFAULT_PIN, LIMITS } from "../../src/shared/protocol";
import { BoardConnection, myOnlyPost, type ClosedReason, type ConnState } from "../lib/realtime";
import { navigate } from "../lib/router";
import { Modal } from "../ui/Modal";
import { PageSpinner } from "../ui/Spinner";
import { toast } from "../ui/Toast";
import { ApiError, studentApi } from "../student/api";
import { getRemembered, getStudentToken as getCurrentToken, setRemembered } from "../student/storage";
import { Comments } from "./Comments";
import { Composer } from "./Composer";
import { BoardCtx, useBoard, useConn, useView, type BoardCtxValue, type ComposeTarget } from "./ctx";
import { Notices } from "./Notices";
import { usePhone, Wall } from "./Wall";
import type { TeacherModule } from "./teacher/types";
import "./board.css";

export interface BoardScreenProps {
  code: string;
  role: "teacher" | "student";
  getToken: () => string | null;
  setToken: (t: string | null) => void;
  onClosed: (reason: ClosedReason) => void;
  /** 학생: 나가기 (토큰 지우고 입장 화면) */
  onLeave: () => void;
  /** 학생: 모두 같은 처음 PIN 으로 막 들어옴 → 바꾸자고 살짝 권한다 */
  pinNudge?: boolean;
}

/** 학생·교사 공용 보드 화면 */
export function BoardScreen(props: BoardScreenProps) {
  const { code, role } = props;
  const conn = useMemo(
    () =>
      new BoardConnection({
        code,
        getToken: props.getToken,
        onToast: (m) => toast(m, { kind: "error" }),
        diagnose: () => diagnose(code, role, props.getToken()),
      }),
    [code, role],
  );
  const [teacher, setTeacher] = useState<TeacherModule | null>(null);
  const [composer, setComposer] = useState<ComposeTarget | null>(null);
  const [commentsFor, setCommentsFor] = useState<string | null>(null);
  const [meOpen, setMeOpen] = useState(false);
  const [nudge, setNudge] = useState(!!props.pinNudge && role === "student");
  const [search, setSearch] = useState(location.search);
  const params = new URLSearchParams(search);
  const projector = role === "teacher" && params.get("view") === "projector";
  const hideNames = params.get("names") === "0";

  useEffect(() => {
    conn.connect();
    return () => conn.close();
  }, [conn]);

  useEffect(() => {
    if (role !== "teacher") return;
    // 교사 전용 코드는 따로 받는다 (학생 화면 번들에 안 들어감)
    void import("./teacher/index").then((m) => setTeacher(m.teacherModule));
  }, [role]);

  useEffect(() => {
    const fn = () => setSearch(location.search);
    addEventListener("popstate", fn);
    return () => removeEventListener("popstate", fn);
  }, []);

  const [state, setState] = useState<ConnState>(conn.getState());
  useEffect(() => {
    // 화면 맨 위는 연결 상태·보드 유무만 본다 (카드 변화로 다시 그리지 않음)
    let last = conn.getState();
    return conn.subscribe(() => {
      const s = conn.getState();
      if (s.status !== last.status || s.closedReason !== last.closedReason || !!s.view !== !!last.view) setState(s);
      last = s;
    });
  }, [conn]);

  useEffect(() => {
    if (state.status === "closed" && state.closedReason) props.onClosed(state.closedReason);
  }, [state.status, state.closedReason]);

  const ctx: BoardCtxValue = useMemo(
    () => ({
      conn,
      code,
      role,
      teacher,
      projector,
      hideNames,
      openComposer: (t) => setComposer(t),
      openComments: (id) => setCommentsFor(id),
    }),
    [conn, code, role, teacher, projector, hideNames],
  );

  if (!state.view) {
    return (
      <PageSpinner
        label={state.status === "reconnecting" || state.status === "offline" ? "연결이 잘 안 돼요. 다시 연결하는 중이에요…" : "보드를 여는 중이에요"}
      />
    );
  }

  return (
    <BoardCtx.Provider value={ctx}>
      <div class={"board" + (projector ? " board-projector" : "")}>
        {projector ? <ProjectorHead /> : <TopBar onLeave={props.onLeave} openMe={() => setMeOpen(true)} />}
        {!projector && teacher ? <teacher.TeacherBar /> : null}
        {!projector && nudge ? (
          <PinNudge
            onChange={() => setMeOpen(true)}
            onDismiss={() => setNudge(false)}
          />
        ) : null}
        {!projector ? <Banners /> : null}
        <Notices />
        <Wall />
        {!projector && role === "student" ? <ComposeFab /> : null}
      </div>
      {composer ? <Composer target={composer} onClose={() => setComposer(null)} /> : null}
      {commentsFor ? <Comments postId={commentsFor} onClose={() => setCommentsFor(null)} /> : null}
      {meOpen ? <MyInfoDialog onClose={() => setMeOpen(false)} setToken={props.setToken} onPinChanged={() => setNudge(false)} /> : null}
    </BoardCtx.Provider>
  );
}

async function diagnose(code: string, role: "teacher" | "student", token: string | null): Promise<ClosedReason | null> {
  if (role === "student") {
    if (!token) return "reauth";
    try {
      await studentApi.me(code, token);
      return null;
    } catch (e) {
      if (!(e instanceof ApiError)) return null;
      if (e.status === 401) return "reauth";
      if (e.code === "archived") return "archived";
      if (e.status === 404) return "not_found";
      return null;
    }
  }
  try {
    const me = await fetch("/api/me", { credentials: "same-origin" });
    if (me.ok && !((await me.json()) as { authenticated?: boolean }).authenticated) return "unauthorized";
    const info = await fetch(`/api/boards/${encodeURIComponent(code)}`);
    if (info.status === 404) return "not_found";
  } catch {
    /* 네트워크 → 계속 재시도 */
  }
  return null;
}

// ───────── 윗줄 ─────────

function StatusPill() {
  const status = useConn((s) => s.status);
  const pending = useConn((s) => s.pendingCount);
  const count = useView((v) => v.presence.count);
  const label =
    status === "open"
      ? `실시간 연결됨, ${count}명 접속 중`
      : status === "offline"
        ? "인터넷이 끊겼어요"
        : "다시 연결하는 중";
  return (
    <span class={"status-pill is-" + status} role="status" aria-label={label} title={label}>
      <span class="status-dot" aria-hidden="true" />
      {status === "open" ? (
        <span>👥 {count}</span>
      ) : status === "offline" ? (
        <span>인터넷 끊김</span>
      ) : (
        <span>다시 연결 중…</span>
      )}
      {status !== "open" && pending > 0 ? <span class="status-pending">· 보낼 것 {pending}개</span> : null}
    </span>
  );
}

/** 잠금 표시: 스크롤해도 늘 보이도록 윗줄에 */
function LockChip() {
  const locked = useView((v) => v.settings.locked);
  if (!locked) return null;
  return (
    <span class="chip chip-warn topbar-lock" title="잠금 중: 볼 수만 있어요">
      🔒<span class="topbar-hide-phone"> 잠금</span>
    </span>
  );
}

function TopBar(props: { onLeave: () => void; openMe: () => void }) {
  const ctx = useBoard();
  const title = useView((v) => v.settings.title);
  const description = useView((v) => v.settings.description);
  const me = useView((v) => v.me);
  const pinChangeable = useView((v) => v.settings.entryMode === "roster" && v.settings.requirePin !== false);
  const [menu, setMenu] = useState(false);
  const [guide, setGuide] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menu) return;
    const onDown = (e: Event) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenu(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMenu(false);
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  return (
    <header class="topbar">
      <div class="topbar-main">
        {ctx.role === "teacher" ? (
          <a
            class="btn btn-small btn-ghost topbar-back"
            href="/teacher"
            onClick={(e) => {
              e.preventDefault();
              navigate("/teacher");
            }}
          >
            ← 내 보드
          </a>
        ) : null}
        <h1 class="topbar-title">{title}</h1>
        {description ? (
          <button type="button" class="btn btn-small btn-ghost" aria-expanded={guide} onClick={() => setGuide(!guide)}>
            ℹ️ <span class="topbar-hide-phone">안내</span>
          </button>
        ) : null}
        <span class="topbar-spacer" />
        <LockChip />
        <StatusPill />
        {ctx.role === "student" ? (
          <div class="menu-wrap" ref={menuRef}>
            <button type="button" class="btn btn-small topbar-me" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(!menu)}>
              🙂 <span class="topbar-me-name">{me.name}</span>
            </button>
            {menu ? (
              <div class="menu" role="menu">
                <p class="menu-info">
                  <strong>{me.name}</strong>
                  {me.number ? <span class="hint">학번 {me.number}</span> : null}
                </p>
                <button
                  type="button"
                  role="menuitem"
                  class="menu-item"
                  onClick={() => {
                    setMenu(false);
                    props.openMe();
                  }}
                >
                  ✏️ 내 정보 (닉네임{pinChangeable ? "·PIN" : ""})
                </button>
                <button
                  type="button"
                  role="menuitem"
                  class="menu-item"
                  onClick={() => {
                    setMenu(false);
                    props.onLeave();
                  }}
                >
                  🚪 나가기
                </button>
              </div>
            ) : null}
          </div>
        ) : (
          <span class="chip chip-primary">🍎 선생님</span>
        )}
      </div>
      {guide && description ? (
        <p class="topbar-guide">
          {description}
        </p>
      ) : null}
    </header>
  );
}

function Banners() {
  const ctx = useBoard();
  const s = useView((v) => v.settings);
  const teacher = ctx.role === "teacher";
  const items: preact.ComponentChildren[] = [];
  if (s.archived) items.push(<p class="banner banner-warn">📦 보관된 보드예요. 읽기만 할 수 있어요.</p>);
  if (s.locked)
    items.push(
      <p class="banner banner-lock" role="status">
        🔒 {teacher ? "잠금 중이에요. 학생은 볼 수만 있어요." : "선생님이 보드를 잠갔어요. 지금은 볼 수만 있어요."}
      </p>,
    );
  if (!teacher && s.anonymous) items.push(<p class="banner banner-soft">🎭 익명 보드예요. 친구 이름은 안 보이고, 내 이름도 친구에게 안 보여요.</p>);
  if (!teacher && s.moderation && !s.locked) items.push(<p class="banner banner-soft">⏳ 선생님이 확인한 카드만 친구들에게 보여요.</p>);
  if (!items.length) return null;
  return <div class="banners">{items}</div>;
}

/** 휴대폰: 떠 있는 글쓰기 단추 */
function ComposeFab() {
  const ctx = useBoard();
  const phone = usePhone();
  const target = useView(
    (v) => {
      const s = v.settings;
      if (s.locked || s.archived) return null;
      const mine = myOnlyPost(v);
      if (mine) return { editId: mine.id, label: "✏️ 내 카드" };
      if (s.columnMode === "topic") return v.columns.length ? { label: "＋ 글쓰기" } : null;
      return v.columns.some((c) => c.mine) ? { label: "＋ 글쓰기" } : null;
    },
    (a, b) => a === b || (!!a && !!b && a.label === b.label && a.editId === b.editId),
  );
  if (!phone || !target) return null;
  return (
    <button type="button" class="btn btn-primary fab" onClick={() => ctx.openComposer(target.editId ? { editId: target.editId } : {})}>
      {target.label}
    </button>
  );
}

/** 처음 PIN(1234)으로 들어온 학생에게: 바꾸자고 살짝 권함 (닫을 수 있음) */
function PinNudge(props: { onChange: () => void; onDismiss: () => void }) {
  return (
    <div class="banners">
      <div class="banner banner-soft pin-nudge" role="status">
        <span class="pin-nudge-text">
          🔑 처음 번호 {DEFAULT_PIN}를 쓰고 있어요. 나만의 번호로 바꿔 볼까요?
        </span>
        <span class="pin-nudge-actions">
          <button type="button" class="btn btn-small btn-primary" onClick={props.onChange}>
            바꾸기
          </button>
          <button type="button" class="btn btn-small btn-ghost" onClick={props.onDismiss} aria-label="안내 닫기">
            다음에
          </button>
        </span>
      </div>
    </div>
  );
}

/** 친구가 쉽게 맞힐 수 있는 번호 (막지는 않고 알려만 줌) */
export function isEasyPin(p: string): boolean {
  if (!/^\d{4}$/.test(p)) return false;
  const d = [...p].map(Number);
  const same = d.every((x) => x === d[0]);
  const up = d.every((x, i) => i === 0 || x === d[i - 1]! + 1);
  const down = d.every((x, i) => i === 0 || x === d[i - 1]! - 1);
  const pair = d[0] === d[2] && d[1] === d[3];
  return same || up || down || pair;
}

function digits4(v: string) {
  return v.replace(/\D/g, "").slice(0, 4);
}

/** 학생 "내 정보": 닉네임 바꾸기 + (PIN 을 묻는 명단 보드면) PIN 바꾸기 */
function MyInfoDialog(props: { onClose: () => void; setToken: (t: string | null) => void; onPinChanged: () => void }) {
  const me = useView((v) => v.me);
  const entryMode = useView((v) => v.settings.entryMode);
  const pinChangeable = useView((v) => v.settings.entryMode === "roster" && v.settings.requirePin !== false);
  return (
    <Modal
      title="내 정보"
      onClose={props.onClose}
      footer={
        <button type="button" class="btn" onClick={props.onClose}>
          닫기
        </button>
      }
    >
      <div class="stack myinfo">
        {me.number ? (
          <p class="muted myinfo-who">
            {me.realName ?? me.name} · 학번 {me.number}
          </p>
        ) : null}
        <NicknameSection setToken={props.setToken} roster={entryMode === "roster"} />
        {pinChangeable ? <PinSection setToken={props.setToken} onChanged={props.onPinChanged} /> : null}
      </div>
    </Modal>
  );
}

function NicknameSection(props: { setToken: (t: string | null) => void; roster: boolean }) {
  const ctx = useBoard();
  const me = useView((v) => v.me);
  const locked = useView((v) => v.settings.locked);
  const [value, setValue] = useState(me.nickname ?? (props.roster ? "" : me.name));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const roster = props.roster;

  const submit = async (e: Event) => {
    e.preventDefault();
    setError(null);
    const n = value.trim();
    if (!roster && !n) return setError("닉네임을 써 주세요.");
    setBusy(true);
    try {
      const t = getCurrentToken(ctx.code);
      if (!t) throw new ApiError(401, "unauthorized", "다시 입장해 주세요.");
      const r = await studentApi.nickname(ctx.code, t, { nickname: n });
      if (r.token) {
        props.setToken(r.token);
        ctx.conn.reconnectNow();
        const rem = getRemembered(ctx.code);
        setRemembered(ctx.code, { ...rem, nickname: r.student.nickname });
      } else {
        const rem = getRemembered(ctx.code);
        if (rem?.number) setRemembered(ctx.code, { ...rem, name: r.student.name });
      }
      toast(n ? `이제 닉네임 "${r.student.name}" 이름표로 보여요.` : "이름으로 보이게 했어요.", { kind: "success" });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "바꾸지 못했어요. 다시 해 주세요.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form class="stack myinfo-section" onSubmit={submit} aria-labelledby="nick-head">
      <h3 id="nick-head" class="myinfo-head">
        닉네임
      </h3>
      <p class="hint" style={{ margin: 0 }}>
        친구들에게 보이는 이름이에요. {roster ? "학번은 바뀌지 않고, 선생님은 원래 이름을 볼 수 있어요." : ""}
      </p>
      <div class="field">
        <label for="nick-input" class="sr-only">
          닉네임
        </label>
        <input
          id="nick-input"
          class="input"
          maxLength={LIMITS.nickname}
          value={value}
          autoComplete="off"
          disabled={locked}
          placeholder={roster ? `비우면 이름(${me.realName ?? ""})으로 보여요` : "예: 별빛"}
          onInput={(e) => setValue((e.currentTarget as HTMLInputElement).value)}
        />
        <span class="hint">전화번호·주소 같은 개인정보는 쓰지 않아요.</span>
      </div>
      {locked ? <p class="hint">🔒 보드가 잠겨서 지금은 닉네임을 바꿀 수 없어요.</p> : null}
      {error ? (
        <p class="error-text" role="alert">
          {error}
        </p>
      ) : null}
      <button type="submit" class="btn btn-primary myinfo-btn" disabled={busy || locked}>
        {busy ? "바꾸는 중…" : "닉네임 바꾸기"}
      </button>
    </form>
  );
}

function PinSection(props: { setToken: (t: string | null) => void; onChanged: () => void }) {
  const ctx = useBoard();
  const [cur, setCur] = useState("");
  const [a, setA] = useState("");
  const [b, setB] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const easy = a.length === 4 && a !== DEFAULT_PIN && isEasyPin(a);

  const submit = async (e: Event) => {
    e.preventDefault();
    setError(null);
    setDone(false);
    if (!/^\d{4}$/.test(cur)) return setError("지금 PIN 숫자 4자리를 써 주세요.");
    if (!/^\d{4}$/.test(a)) return setError("새 PIN은 숫자 4자리로 정해 주세요.");
    if (a === DEFAULT_PIN) return setError(`${DEFAULT_PIN}는 모두가 아는 처음 번호라서 쓸 수 없어요. 다른 숫자로 정해 주세요.`);
    if (a === cur) return setError("지금 PIN과 다른 번호로 정해 주세요.");
    if (a !== b) return setError("새 PIN을 두 번 똑같이 써 주세요.");
    setBusy(true);
    try {
      // 바꾸면 이 학생의 예전 입장(다른 기기 포함)이 모두 끝나므로, 지금 연결은 잠시 멈췄다가 새 토큰으로 다시 붙는다
      await ctx.conn.withTokenChange(async () => {
        const t = getCurrentToken(ctx.code);
        if (!t) throw new ApiError(401, "unauthorized", "다시 입장해 주세요.");
        const r = await studentApi.changePin(ctx.code, t, { currentPin: cur, newPin: a });
        props.setToken(r.token);
      });
      setCur("");
      setA("");
      setB("");
      setDone(true);
      props.onChanged();
      toast("PIN을 바꿨어요. 다음부터 새 PIN으로 들어와요.", { kind: "success" });
    } catch (err) {
      setCur("");
      setError(err instanceof ApiError ? err.message : "바꾸지 못했어요. 다시 해 주세요.");
    } finally {
      setBusy(false);
    }
  };

  const pinInput = (id: string, label: string, value: string, set: (v: string) => void, auto: string) => (
    <div class="field">
      <label for={id}>{label}</label>
      <input
        id={id}
        class="input myinfo-pin"
        type="password"
        inputMode="numeric"
        autoComplete={auto}
        maxLength={4}
        placeholder="••••"
        value={value}
        onInput={(e) => {
          set(digits4((e.currentTarget as HTMLInputElement).value));
          setError(null);
          setDone(false);
        }}
      />
    </div>
  );

  return (
    <form class="stack myinfo-section" onSubmit={submit} aria-labelledby="pin-head" noValidate>
      <h3 id="pin-head" class="myinfo-head">
        PIN 바꾸기
      </h3>
      <p class="hint" style={{ margin: 0 }}>
        나만 아는 숫자 4자리로 바꾸면 친구가 내 이름으로 들어올 수 없어요. 친구에게 알려 주지 마세요.
      </p>
      {pinInput("pin-cur", "지금 PIN", cur, setCur, "current-password")}
      <div class="myinfo-pin-row">
        {pinInput("pin-new", "새 PIN", a, setA, "new-password")}
        {pinInput("pin-again", "새 PIN 한 번 더", b, setB, "new-password")}
      </div>
      {easy ? <p class="hint myinfo-warn">⚠️ 친구가 맞히기 쉬운 번호예요. 다른 번호면 더 안전해요.</p> : null}
      {error ? (
        <p class="error-text" role="alert">
          {error}
        </p>
      ) : null}
      {done ? (
        <p class="myinfo-done" role="status">
          ✅ 새 PIN으로 바꿨어요. 다음부터 새 PIN으로 들어와요.
        </p>
      ) : null}
      <button type="submit" class="btn btn-primary myinfo-btn" disabled={busy}>
        {busy ? "바꾸는 중…" : "PIN 바꾸기"}
      </button>
    </form>
  );
}

// ───────── 프로젝터 ─────────

function ProjectorHead() {
  const title = useView((v) => v.settings.title);
  const code = useView((v) => v.board.code);
  const count = useView((v) => v.presence.count);
  const params = new URLSearchParams(location.search);
  const hide = params.get("names") === "0";
  const set = (names: boolean | null) => {
    const p = new URLSearchParams(location.search);
    if (names === null) {
      p.delete("view");
      p.delete("names");
    } else if (names) p.delete("names");
    else p.set("names", "0");
    const q = p.toString();
    history.replaceState(null, "", location.pathname + (q ? "?" + q : ""));
    dispatchEvent(new PopStateEvent("popstate"));
  };
  return (
    <header class="proj-head">
      <div class="proj-title-wrap">
        <h1 class="proj-title">{title}</h1>
        <p class="proj-sub">
          {location.host}/b/<strong>{code}</strong> · 👥 {count}
        </p>
      </div>
      <div class="row proj-tools">
        <button type="button" class="btn btn-small" aria-pressed={hide} onClick={() => set(hide)}>
          {hide ? "이름 보이기" : "이름 숨기기"}
        </button>
        <button
          type="button"
          class="btn btn-small"
          onClick={() => {
            if (document.fullscreenElement) void document.exitFullscreen();
            else void document.documentElement.requestFullscreen?.().catch(() => {});
          }}
        >
          전체 화면
        </button>
        <button type="button" class="btn btn-small" onClick={() => set(null)}>
          ✕ 나가기
        </button>
      </div>
    </header>
  );
}
