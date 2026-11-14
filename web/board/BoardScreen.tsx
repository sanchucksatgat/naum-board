import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { LIMITS } from "../../src/shared/protocol";
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
        {projector ? <ProjectorHead /> : <TopBar onLeave={props.onLeave} setToken={props.setToken} />}
        {!projector && teacher ? <teacher.TeacherBar /> : null}
        {!projector ? <Banners /> : null}
        <Notices />
        <Wall />
        {!projector && role === "student" ? <ComposeFab /> : null}
      </div>
      {composer ? <Composer target={composer} onClose={() => setComposer(null)} /> : null}
      {commentsFor ? <Comments postId={commentsFor} onClose={() => setCommentsFor(null)} /> : null}
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

function TopBar(props: { onLeave: () => void; setToken: (t: string | null) => void }) {
  const ctx = useBoard();
  const title = useView((v) => v.settings.title);
  const description = useView((v) => v.settings.description);
  const me = useView((v) => v.me);
  const [menu, setMenu] = useState(false);
  const [nick, setNick] = useState(false);
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
                    setNick(true);
                  }}
                >
                  ✏️ 닉네임 바꾸기
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
      {nick ? <NicknameDialog onClose={() => setNick(false)} setToken={props.setToken} /> : null}
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

function NicknameDialog(props: { onClose: () => void; setToken: (t: string | null) => void }) {
  const ctx = useBoard();
  const me = useView((v) => v.me);
  const entryMode = useView((v) => v.settings.entryMode);
  const locked = useView((v) => v.settings.locked);
  const [value, setValue] = useState(me.nickname ?? (entryMode === "free" ? me.name : ""));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const roster = entryMode === "roster";

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
      toast(n ? `이제 "${r.student.name}"(으)로 보여요.` : "이름으로 보이게 했어요.", { kind: "success" });
      props.onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "바꾸지 못했어요. 다시 해 주세요.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="닉네임 바꾸기"
      onClose={props.onClose}
      footer={
        <>
          <button type="button" class="btn" onClick={props.onClose}>
            취소
          </button>
          <button type="submit" form="nick-form" class="btn btn-primary" disabled={busy || locked}>
            바꾸기
          </button>
        </>
      }
    >
      <form id="nick-form" class="stack" onSubmit={submit}>
        <p class="muted" style={{ margin: 0 }}>
          친구들에게 보이는 이름이에요. {roster ? "학번은 바뀌지 않고, 선생님은 원래 이름을 볼 수 있어요." : ""}
        </p>
        <div class="field">
          <label for="nick-input">닉네임</label>
          <input
            id="nick-input"
            class="input"
            maxLength={LIMITS.nickname}
            value={value}
            autoComplete="off"
            placeholder={roster ? `비우면 이름(${me.realName ?? ""})으로 보여요` : "예: 별빛"}
            onInput={(e) => setValue((e.currentTarget as HTMLInputElement).value)}
          />
          <span class="hint">전화번호·주소 같은 개인정보는 쓰지 않아요.</span>
        </div>
        {locked ? <p class="hint">🔒 보드가 잠겨서 지금은 바꿀 수 없어요.</p> : null}
        {error ? (
          <p class="error-text" role="alert">
            {error}
          </p>
        ) : null}
      </form>
    </Modal>
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
