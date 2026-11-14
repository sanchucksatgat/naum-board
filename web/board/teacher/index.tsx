/**
 * 보드 안 교사 도구 (학생 번들에 들어가지 않게 BoardScreen 이 import() 로 불러온다).
 * 카드 승인·숨김·피드백, 공지, 주제별 열 관리, 빠른 설정, 미제출 목록, 백업 상태, 프로젝터.
 */
import { useEffect, useRef, useState } from "preact/hooks";
import { LIMITS, type BackupInfo, type BoardSettingsPatch } from "../../../src/shared/protocol";
import { Modal } from "../../ui/Modal";
import { Switch } from "../../ui/Switch";
import { confirmDialog } from "../../ui/ConfirmDialog";
import { shallowEqualArray } from "../../lib/realtime-state";
import { useBoard, useView } from "../ctx";
import { colDomId } from "../Wall";
import { formatTime } from "../format";
import type { TeacherModule } from "./types";
import "./teacher.css";

// ───────── 카드 ─────────

function CardActions(props: { postId: string }) {
  const { conn } = useBoard();
  const post = useView((v) => v.posts[props.postId]);
  const archived = useView((v) => v.settings.archived);
  const [fb, setFb] = useState(false);
  if (!post || archived) return null;
  const mod = (action: "approve" | "hide" | "unhide") => void conn.send({ t: "post.moderate", postId: post.id, action });
  return (
    <div class="bcard-teacher" role="group" aria-label="선생님 도구">
      {post.status === "pending" ? (
        <button type="button" class="btn btn-small btn-primary" onClick={() => mod("approve")}>
          ✅ 승인
        </button>
      ) : null}
      {post.status === "hidden" ? (
        <button type="button" class="btn btn-small" onClick={() => mod("unhide")}>
          👁️ 다시 보이기
        </button>
      ) : (
        <button type="button" class="btn btn-small" onClick={() => mod("hide")}>
          🙈 숨기기
        </button>
      )}
      {post.authorRef !== "teacher" ? (
        <button type="button" class="btn btn-small" onClick={() => setFb(true)}>
          📝 {post.feedback ? "피드백 고치기" : "피드백"}
        </button>
      ) : null}
      {fb ? <FeedbackDialog postId={post.id} onClose={() => setFb(false)} /> : null}
    </div>
  );
}

function FeedbackDialog(props: { postId: string; onClose: () => void }) {
  const { conn } = useBoard();
  const post = useView((v) => v.posts[props.postId]);
  const [body, setBody] = useState(post?.feedback?.body ?? "");
  if (!post) return null;
  const save = (text: string) => {
    void conn.send({ t: "feedback.set", postId: post.id, body: text });
    props.onClose();
  };
  return (
    <Modal
      title={`📝 ${post.authorName}에게 피드백`}
      onClose={props.onClose}
      persistent={body !== (post.feedback?.body ?? "")}
      footer={
        <>
          {post.feedback ? (
            <button type="button" class="btn btn-danger" onClick={() => save("")}>
              피드백 지우기
            </button>
          ) : null}
          <button type="button" class="btn" onClick={props.onClose}>
            취소
          </button>
          <button type="submit" form="fb-form" class="btn btn-primary" disabled={!body.trim()}>
            저장
          </button>
        </>
      }
    >
      <form
        id="fb-form"
        class="stack"
        onSubmit={(e) => {
          e.preventDefault();
          if (body.trim()) save(body.trim());
        }}
      >
        <p class="hint" style={{ margin: 0 }}>
          이 학생과 선생님만 볼 수 있어요.
        </p>
        <label class="sr-only" for="fb-body">
          피드백
        </label>
        <textarea id="fb-body" class="textarea" rows={5} maxLength={LIMITS.feedbackBody} value={body} onInput={(e) => setBody((e.currentTarget as HTMLTextAreaElement).value)} />
      </form>
    </Modal>
  );
}

// ───────── 공지 ─────────

function NoticeDialog(props: { noticeId?: string; onClose: () => void }) {
  const { conn } = useBoard();
  const existing = useView((v) => (props.noticeId ? v.notices.find((n) => n.id === props.noticeId) : undefined));
  const [title, setTitle] = useState(existing?.title ?? "");
  const [body, setBody] = useState(existing?.body ?? "");
  const [err, setErr] = useState<string | null>(null);
  return (
    <Modal
      title={existing ? "공지 고치기" : "📢 새 공지"}
      onClose={props.onClose}
      persistent={title !== (existing?.title ?? "") || body !== (existing?.body ?? "")}
      footer={
        <>
          <button type="button" class="btn" onClick={props.onClose}>
            취소
          </button>
          <button type="submit" form="notice-form" class="btn btn-primary">
            {existing ? "저장" : "공지 올리기"}
          </button>
        </>
      }
    >
      <form
        id="notice-form"
        class="stack"
        onSubmit={(e) => {
          e.preventDefault();
          if (!title.trim() && !body.trim()) return setErr("제목이나 내용을 써 주세요.");
          void conn.send({ t: "notice.save", notice: { ...(existing ? { id: existing.id } : {}), title: title.trim(), body: body.trim() } });
          props.onClose();
        }}
      >
        <div class="field">
          <label for="notice-title">제목</label>
          <input id="notice-title" class="input" maxLength={LIMITS.noticeTitle} value={title} onInput={(e) => setTitle((e.currentTarget as HTMLInputElement).value)} />
        </div>
        <div class="field">
          <label for="notice-body">내용</label>
          <textarea id="notice-body" class="textarea" rows={4} maxLength={LIMITS.noticeBody} value={body} onInput={(e) => setBody((e.currentTarget as HTMLTextAreaElement).value)} />
        </div>
        {err ? <p class="error-text">{err}</p> : null}
      </form>
    </Modal>
  );
}

function NewNoticeButton(props: { compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const archived = useView((v) => v.settings.archived);
  if (archived) return null;
  return (
    <>
      <button type="button" class={"btn btn-small" + (props.compact ? " btn-ghost" : "")} onClick={() => setOpen(true)}>
        📢 공지 쓰기
      </button>
      {open ? <NoticeDialog onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function NoticeActions(props: { noticeId: string }) {
  const { conn } = useBoard();
  const [edit, setEdit] = useState(false);
  return (
    <span class="row notice-actions">
      <button type="button" class="btn btn-small btn-ghost" aria-label="공지 고치기" onClick={() => setEdit(true)}>
        ✏️
      </button>
      <button
        type="button"
        class="btn btn-small btn-ghost"
        aria-label="공지 지우기"
        onClick={async () => {
          if (await confirmDialog({ title: "공지를 지울까요?", okLabel: "지우기", danger: true })) void conn.send({ t: "notice.delete", noticeId: props.noticeId });
        }}
      >
        🗑️
      </button>
      {edit ? <NoticeDialog noticeId={props.noticeId} onClose={() => setEdit(false)} /> : null}
    </span>
  );
}

// ───────── 주제별 열 ─────────

function ColumnTitleDialog(props: { columnId?: string; onClose: () => void }) {
  const { conn } = useBoard();
  const col = useView((v) => (props.columnId ? v.columns.find((c) => c.id === props.columnId) : undefined));
  const [title, setTitle] = useState(col?.title ?? "");
  return (
    <Modal
      title={col ? "칸 이름 바꾸기" : "새 칸 만들기"}
      onClose={props.onClose}
      footer={
        <>
          <button type="button" class="btn" onClick={props.onClose}>
            취소
          </button>
          <button type="submit" form="col-form" class="btn btn-primary" disabled={!title.trim()}>
            {col ? "저장" : "만들기"}
          </button>
        </>
      }
    >
      <form
        id="col-form"
        class="stack"
        onSubmit={(e) => {
          e.preventDefault();
          const t = title.trim();
          if (!t) return;
          void conn.send({ t: "column.save", column: { ...(col ? { id: col.id } : {}), title: t } });
          props.onClose();
        }}
      >
        <div class="field">
          <label for="col-title">칸 이름</label>
          <input id="col-title" class="input" maxLength={LIMITS.columnTitle} value={title} placeholder="예: 궁금한 점" onInput={(e) => setTitle((e.currentTarget as HTMLInputElement).value)} />
        </div>
      </form>
    </Modal>
  );
}

function AddColumn() {
  const [open, setOpen] = useState(false);
  const n = useView((v) => v.columns.length);
  const archived = useView((v) => v.settings.archived);
  if (archived || n >= LIMITS.columnsPerBoard) return null;
  return (
    <>
      <button type="button" class="col-add col-add-new" onClick={() => setOpen(true)}>
        ＋ 칸 추가
      </button>
      {open ? <ColumnTitleDialog onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function ColumnMenu(props: { columnId: string }) {
  const { conn } = useBoard();
  const columns = useView((v) => v.columns);
  const archived = useView((v) => v.settings.archived);
  const [open, setOpen] = useState(false);
  const [rename, setRename] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const fn = (e: Event) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const key = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", fn);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", fn);
      document.removeEventListener("keydown", key);
    };
  }, [open]);
  if (archived || props.columnId.startsWith("tmp:")) return null;
  const i = columns.findIndex((c) => c.id === props.columnId);
  const col = columns[i];
  if (!col) return null;
  const moveTo = (j: number) => {
    const ids = columns.map((c) => c.id).filter((id) => !id.startsWith("tmp:"));
    const from = ids.indexOf(col.id);
    if (from < 0 || j < 0 || j >= ids.length) return;
    ids.splice(from, 1);
    ids.splice(j, 0, col.id);
    void conn.send({ t: "column.reorder", order: ids });
    setOpen(false);
    requestAnimationFrame(() => document.getElementById(colDomId(col.id))?.scrollIntoView({ block: "nearest", inline: "nearest" }));
  };
  return (
    <div class="menu-wrap col-menu" ref={ref}>
      <button type="button" class="btn btn-small btn-ghost" aria-haspopup="menu" aria-expanded={open} aria-label={`${col.title} 칸 관리`} onClick={() => setOpen(!open)}>
        ⋯
      </button>
      {open ? (
        <div class="menu menu-right" role="menu">
          <button
            type="button"
            role="menuitem"
            class="menu-item"
            onClick={() => {
              setOpen(false);
              setRename(true);
            }}
          >
            ✏️ 이름 바꾸기
          </button>
          <button type="button" role="menuitem" class="menu-item" disabled={i === 0} onClick={() => moveTo(i - 1)}>
            ← 앞으로
          </button>
          <button type="button" role="menuitem" class="menu-item" disabled={i === columns.length - 1} onClick={() => moveTo(i + 1)}>
            뒤로 →
          </button>
          <button
            type="button"
            role="menuitem"
            class="menu-item menu-danger"
            disabled={columns.length <= 1}
            onClick={async () => {
              setOpen(false);
              if (await confirmDialog({ title: `"${col.title}" 칸을 지울까요?`, message: "카드가 있는 칸은 지울 수 없어요. 카드를 먼저 옮기거나 지워 주세요.", okLabel: "지우기", danger: true }))
                void conn.send({ t: "column.delete", columnId: col.id });
            }}
          >
            🗑️ 지우기
          </button>
        </div>
      ) : null}
      {rename ? <ColumnTitleDialog columnId={col.id} onClose={() => setRename(false)} /> : null}
    </div>
  );
}

// ───────── 윗줄 교사 도구 ─────────

function backupText(b: BackupInfo | undefined, now: number): { text: string; kind: "ok" | "warn" | "danger" | "muted"; title: string } {
  if (!b) return { text: "백업 확인 중", kind: "muted", title: "" };
  const ago = (t: number | null) => {
    if (!t) return "";
    const m = Math.round((now - t) / 60000);
    return m < 1 ? "방금" : m < 60 ? `${m}분 전` : formatTime(t, now);
  };
  switch (b.state) {
    case "ok":
      return { text: `☁️ 백업됨 · ${ago(b.lastSuccessAt)}`, kind: "ok", title: "Google 드라이브에 글이 저장되어 있어요." };
    case "pending":
      return { text: "☁️ 곧 백업해요", kind: "muted", title: "바뀐 내용을 30초 안에 Google 드라이브에 저장해요." };
    case "error":
      return { text: "⚠️ 백업 실패", kind: "danger", title: (b.lastError ?? "") + (b.nextAttemptAt ? ` · 다시 시도: ${formatTime(b.nextAttemptAt, now)}` : "") };
    case "unavailable":
      return { text: "⚠️ 드라이브 연결 끊김", kind: "danger", title: "선생님 화면에서 Google 계정을 다시 연결해 주세요." };
    default:
      return { text: "☁️ 아직 백업 전", kind: "muted", title: "첫 글이 올라오면 Google 드라이브에 저장해요." };
  }
}

function BackupBadge() {
  const backup = useView((v) => v.backup);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  const b = backupText(backup, now);
  if (backup?.state === "error" && backup.lastErrorCode === "api_disabled") {
    // Drive API 가 꺼진 경우: 해결 방법(설치 안내 도움말)으로 바로 보낸다
    return (
      <a class={"chip tbar-backup is-" + b.kind} title={b.title} href="/setup#help-api" target="_blank" rel="noopener">
        ⚠️ 백업 실패 · Drive API 켜기
      </a>
    );
  }
  return (
    <span class={"chip tbar-backup is-" + b.kind} title={b.title}>
      {b.text}
    </span>
  );
}

function SettingsDialog(props: { onClose: () => void }) {
  const { conn } = useBoard();
  const s = useView((v) => v.settings);
  const set = async (patch: BoardSettingsPatch, ask?: { title: string; message: string }) => {
    if (ask && !(await confirmDialog({ ...ask, okLabel: "바꾸기" }))) return;
    void conn.send({ t: "settings.update", patch });
  };
  return (
    <Modal title="⚙️ 빠른 설정" onClose={props.onClose} footer={<button type="button" class="btn btn-primary" onClick={props.onClose}>닫기</button>}>
      <div class="stack">
        <Switch checked={s.locked} label="🔒 잠금" hint="학생은 볼 수만 있어요 (글·댓글·좋아요 안 됨)" onChange={(v) => void set({ locked: v })} />
        <Switch checked={s.moderation} label="⏳ 승인 후 게시" hint="학생 카드는 선생님이 승인해야 모두에게 보여요" onChange={(v) => void set({ moderation: v })} />
        <Switch
          checked={s.anonymous}
          label="🎭 익명 모드"
          hint="학생 화면에서 친구 이름·학번이 안 보여요 (선생님은 보임)"
          onChange={(v) =>
            void set(
              { anonymous: v },
              { title: v ? "익명 모드를 켤까요?" : "익명 모드를 끌까요?", message: v ? "학생 화면에서 다른 친구의 이름이 모두 '익명'으로 바뀌어요." : "학생 화면에 친구들의 이름이 다시 보여요." },
            )
          }
        />
        <Switch checked={s.allowLikes} label="❤️ 좋아요 허용" onChange={(v) => void set({ allowLikes: v })} />
        <Switch checked={s.allowComments} label="💬 댓글 허용" onChange={(v) => void set({ allowComments: v })} />
        <p class="hint">
          보드 이름·안내문·입장 방식·명단은 <a href="/teacher">선생님 화면</a>에서 바꿔요.
        </p>
      </div>
    </Modal>
  );
}

function NotSubmittedDialog(props: { onClose: () => void }) {
  const list = useView((v) => {
    const ns = new Set(v.notSubmitted ?? []);
    return (v.roster ?? []).filter((r) => ns.has(r.ref));
  }, shallowEqualArray);
  const onlineList = useView((v) => v.presence.online ?? []);
  const online = new Set(onlineList);
  return (
    <Modal title={`📝 아직 안 쓴 학생 ${list.length}명`} onClose={props.onClose} footer={<button type="button" class="btn btn-primary" onClick={props.onClose}>닫기</button>}>
      {list.length === 0 ? (
        <p class="muted">모두 카드를 썼어요! 🎉</p>
      ) : (
        <ul class="ns-list">
          {list.map((r) => (
            <li key={r.ref} class="ns-item">
              <span class="ns-num">{r.number}</span>
              <span class="ns-name">{r.name}</span>
              {r.nickname && r.nickname !== r.name ? <span class="hint">({r.nickname})</span> : null}
              {online.has(r.ref) ? <span class="chip chip-primary">접속 중</span> : null}
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}

function TeacherBar() {
  const { conn, code } = useBoard();
  const s = useView((v) => v.settings);
  const pendingCount = useView((v) => {
    let n = 0;
    for (const id of v.order) if (v.posts[id]?.status === "pending") n++;
    return n;
  });
  const ns = useView((v) => v.notSubmitted?.length ?? null);
  const [settings, setSettings] = useState(false);
  const [nsOpen, setNsOpen] = useState(false);

  const jumpPending = () => {
    const el = document.querySelector<HTMLElement>(".bcard.is-pending");
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.add("is-flash");
    setTimeout(() => el.classList.remove("is-flash"), 1500);
  };

  return (
    <nav class="tbar" aria-label="선생님 도구">
      {s.archived ? null : (
        <button
          type="button"
          class={"btn btn-small" + (s.locked ? " tbar-on" : "")}
          aria-pressed={s.locked}
          onClick={() => void conn.send({ t: "settings.update", patch: { locked: !s.locked } })}
        >
          {s.locked ? "🔓 잠금 풀기" : "🔒 잠그기"}
        </button>
      )}
      {s.archived ? null : (
        <button type="button" class="btn btn-small" onClick={() => setSettings(true)}>
          ⚙️ 빠른 설정
        </button>
      )}
      {pendingCount > 0 ? (
        <button type="button" class="btn btn-small tbar-pending" onClick={jumpPending}>
          ⏳ 승인 대기 {pendingCount}
        </button>
      ) : null}
      {ns !== null && s.entryMode === "roster" ? (
        <button type="button" class="btn btn-small" onClick={() => setNsOpen(true)}>
          📝 안 쓴 학생 {ns}
        </button>
      ) : null}
      <span class="tbar-flags">
        {s.moderation ? <span class="chip chip-warn">승인 후 게시</span> : null}
        {s.anonymous ? <span class="chip">🎭 익명</span> : null}
        {!s.allowComments ? <span class="chip">댓글 끔</span> : null}
        {!s.allowLikes ? <span class="chip">좋아요 끔</span> : null}
      </span>
      <span class="tbar-spacer" />
      <BackupBadge />
      <a class="btn btn-small" href={`/b/${code}?view=projector`} target="_blank" rel="noopener">
        📺 프로젝터
      </a>
      <a class="btn btn-small" href={`/b/${code}?as=student`} target="_blank" rel="noopener" title="새 창에서 학생 입장 화면을 열어요">
        👀 학생 화면
      </a>
      {settings ? <SettingsDialog onClose={() => setSettings(false)} /> : null}
      {nsOpen ? <NotSubmittedDialog onClose={() => setNsOpen(false)} /> : null}
    </nav>
  );
}

export const teacherModule: TeacherModule = {
  CardActions,
  TeacherBar: TeacherBar as TeacherModule["TeacherBar"],
  ColumnMenu,
  AddColumn: AddColumn as TeacherModule["AddColumn"],
  NoticeActions,
  NewNoticeButton,
};

