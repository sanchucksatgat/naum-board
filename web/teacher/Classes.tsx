/** 반 목록, 반 만들기, 반 명단(학생 추가·수정·삭제·모둠·PIN 초기화·잠금 해제·내려받기) */
import type { ComponentChildren, JSX } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import { LIMITS, type ClassSummary, type StudentRowInput, type TeacherStudent } from "../../src/shared/protocol";
import { api, errorMessage } from "./api";
import { formatDateTime } from "./format";
import { Link, go } from "./nav";
import { RosterImport } from "./RosterImport";
import { compareNumber, rosterCsv, safeFileName } from "./roster";
import { Empty, ErrorBox, Loading, Modal, TypeToConfirm, downloadText, toast, useAction, useAsync } from "./ui";

// ───────────── 반 목록 ─────────────

export function ClassList() {
  const [classes, reload] = useAsync(() => api.classes(), []);
  const [creating, setCreating] = useState(false);
  useEffect(() => {
    document.title = "반·명단 · 나눔보드";
  }, []);
  return (
    <div class="stack t-page">
      <div class="t-page-head">
        <h1 class="t-h1">반·명단</h1>
        <button type="button" class="btn btn-primary" onClick={() => setCreating(true)}>
          + 새 반 만들기
        </button>
      </div>
      <p class="muted">반마다 학생 명단을 한 번 넣어 두면, 명단 입장 보드에서 여러 번 쓸 수 있어요.</p>
      {classes.status === "loading" && <Loading text="반 목록을 불러오는 중이에요…" />}
      {classes.status === "error" && <ErrorBox error={classes.error} onRetry={reload} />}
      {classes.status === "ok" &&
        (classes.data.length ? (
          <ul class="t-class-grid">
            {classes.data.map((c) => (
              <li key={c.id} class="card t-class">
                <h2 class="t-board-title">
                  <Link href={`/teacher/classes/${c.id}`}>{c.name}</Link>
                </h2>
                <p class="hint">
                  학생 {c.studentCount}명 · 연결된 보드 {c.boardCount}개
                </p>
                <div class="row">
                  <Link href={`/teacher/classes/${c.id}`} class="btn btn-small">
                    명단 보기
                  </Link>
                  <Link href={`/teacher/classes/${c.id}/pins`} class="btn btn-small">
                    PIN 쪽지
                  </Link>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <Empty title="아직 만든 반이 없어요.">
            <p class="muted">반 이름을 정하고 학생 명단을 붙여 넣으면 돼요.</p>
            <button type="button" class="btn btn-primary" onClick={() => setCreating(true)}>
              + 새 반 만들기
            </button>
          </Empty>
        ))}
      {creating && (
        <CreateClass
          onClose={() => setCreating(false)}
          onCreated={(c) => {
            setCreating(false);
            toast(`‘${c.name}’ 반을 만들었어요.`);
            go(`/teacher/classes/${c.id}`);
          }}
        />
      )}
    </div>
  );
}

function CreateClass(props: { onClose: () => void; onCreated: (c: ClassSummary) => void }) {
  const [name, setName] = useState("");
  const [rows, setRows] = useState<StudentRowInput[]>([]);
  const [ready, setReady] = useState(false);
  const [touchedRoster, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: JSX.TargetedEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!name.trim()) return setError("반 이름을 입력해 주세요.");
    if (touchedRoster && !ready) return setError("명단에 고칠 줄이 있어요. 고치거나 명단 칸을 비워 주세요.");
    setBusy(true);
    setError(null);
    try {
      const r = await api.createClass(name.trim(), rows.length ? rows : undefined);
      props.onCreated(r.class);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="새 반 만들기" onClose={props.onClose} busy={busy} wide>
      <form class="stack" onSubmit={submit} noValidate>
        <div class="field">
          <label for="cc-name">반 이름</label>
          <input id="cc-name" class="input" maxLength={LIMITS.className} value={name} placeholder="예: 3학년 2반" data-autofocus onInput={(e) => setName(e.currentTarget.value)} />
        </div>
        <RosterImport
          idPrefix="cc"
          onChange={(v, ok) => {
            setRows(v);
            setReady(ok);
            setTouched(v.length > 0 || !ok);
          }}
        />
        {error && (
          <p class="error-text" role="alert">
            {error}
          </p>
        )}
        <div class="row t-end">
          <button type="button" class="btn" onClick={props.onClose} disabled={busy}>
            취소
          </button>
          <button type="submit" class="btn btn-primary" disabled={busy}>
            {busy ? "만드는 중…" : rows.length ? `반 만들고 ${rows.length}명 넣기` : "반 만들기"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ───────────── 반 명단 ─────────────

type ClassDialog =
  | null
  | { kind: "add" }
  | { kind: "rename" }
  | { kind: "delete" }
  | { kind: "edit"; student: TeacherStudent }
  | { kind: "remove"; student: TeacherStudent }
  | { kind: "reset"; student: TeacherStudent };

export function ClassDetail(props: { id: string }) {
  const [cls, reloadCls, mutateCls] = useAsync(async () => {
    const list = await api.classes();
    const c = list.find((x) => x.id === props.id);
    if (!c) throw new Error("반을 찾을 수 없어요. 이미 지워졌을 수 있어요.");
    return c;
  }, [props.id]);
  const [students, reload, mutate] = useAsync(() => api.students(props.id), [props.id]);
  const [dialog, setDialog] = useState<ClassDialog>(null);
  const [query, setQuery] = useState("");
  const [busy, run] = useAction();

  useEffect(() => {
    if (cls.status === "ok") document.title = `${cls.data.name} · 나눔보드`;
  }, [cls]);

  const list = students.status === "ok" ? students.data : [];
  const filtered = useMemo(() => {
    const q = query.trim().toLocaleLowerCase("ko");
    return [...list].sort(compareNumber).filter((s) => !q || `${s.number} ${s.name} ${s.nickname} ${s.group}`.toLocaleLowerCase("ko").includes(q));
  }, [list, query]);
  const groups = useMemo(() => [...new Set(list.map((s) => s.group).filter(Boolean))].sort((a, b) => a.localeCompare(b, "ko", { numeric: true })), [list]);
  const replace = (s: TeacherStudent) => mutate((all) => all.map((x) => (x.id === s.id ? s : x)));

  if (cls.status === "loading") return <Loading text="반 정보를 불러오는 중이에요…" />;
  if (cls.status === "error")
    return (
      <div class="stack t-page">
        <p>
          <Link href="/teacher/classes" class="t-back">
            ← 반·명단
          </Link>
        </p>
        <ErrorBox error={cls.error} onRetry={reloadCls} />
      </div>
    );
  const c = cls.data;
  const registered = list.filter((s) => s.pinRegistered).length;
  const now = Date.now();

  const unlock = (s: TeacherStudent) =>
    run(async () => {
      replace(await api.unlock(s.id));
      toast(`${s.name} 학생의 잠금을 풀었어요.`);
    });

  return (
    <div class="stack t-page">
      <p class="no-print">
        <Link href="/teacher/classes" class="t-back">
          ← 반·명단
        </Link>
      </p>
      <div class="t-page-head">
        <div class="t-minw0">
          <h1 class="t-h1 t-break">{c.name}</h1>
          <p class="hint">
            학생 {list.length}명 · 나만의 PIN 등록 {registered}명 · 연결된 보드 {c.boardCount}개
          </p>
        </div>
        <div class="row">
          <button type="button" class="btn btn-small" onClick={() => setDialog({ kind: "rename" })}>
            이름 바꾸기
          </button>
          <button type="button" class="btn btn-small btn-danger" onClick={() => setDialog({ kind: "delete" })}>
            반 지우기
          </button>
        </div>
      </div>

      <div class="t-actions-bar">
        <button type="button" class="btn btn-primary" onClick={() => setDialog({ kind: "add" })}>
          + 학생 추가
        </button>
        <Link href={`/teacher/classes/${c.id}/pins`} class="btn">
          PIN 쪽지 인쇄
        </Link>
        <button
          type="button"
          class="btn"
          disabled={!list.length}
          onClick={() => downloadText(`학생명단_${safeFileName(c.name)}.csv`, rosterCsv(list))}
        >
          명단·PIN 내려받기
        </button>
        <Link href={`/teacher/portfolio?class=${c.id}`} class="btn">
          포트폴리오
        </Link>
      </div>
      <p class="hint">
        초기 PIN은 학생이 처음 들어와 ‘나만의 PIN’을 정하기 전까지만 보여요. 나만의 PIN은 선생님도 알 수 없어요. 잊었다면 ‘PIN 초기화’를 눌러 새 초기
        PIN을 주세요.
      </p>

      {students.status === "loading" && <Loading text="명단을 불러오는 중이에요…" />}
      {students.status === "error" && <ErrorBox error={students.error} onRetry={reload} />}
      {students.status === "ok" &&
        (list.length === 0 ? (
          <Empty title="아직 학생이 없어요.">
            <p class="muted">엑셀이나 구글 시트의 명단을 복사해 붙여 넣으면 한 번에 들어가요.</p>
            <button type="button" class="btn btn-primary" onClick={() => setDialog({ kind: "add" })}>
              + 학생 추가
            </button>
          </Empty>
        ) : (
          <>
            <div class="t-search">
              <label for="stu-search" class="sr-only">
                학생 찾기
              </label>
              <input id="stu-search" class="input" type="search" placeholder="학번·이름·모둠으로 찾기" value={query} onInput={(e) => setQuery(e.currentTarget.value)} />
            </div>
            <div class="t-table-wrap">
              <table class="t-table t-roster">
                <thead>
                  <tr>
                    <th scope="col">학번</th>
                    <th scope="col">이름</th>
                    <th scope="col">모둠</th>
                    <th scope="col">닉네임</th>
                    <th scope="col">PIN</th>
                    <th scope="col">
                      <span class="sr-only">관리</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((s) => {
                    const locked = !!s.lockedUntil && s.lockedUntil > now;
                    return (
                      <tr key={s.id}>
                        <td data-label="학번">{s.number}</td>
                        <td data-label="이름" class="t-strong">
                          {s.name}
                        </td>
                        <td data-label="모둠">{s.group || <span class="hint">없음</span>}</td>
                        <td data-label="닉네임">{s.nickname || <span class="hint">없음</span>}</td>
                        <td data-label="PIN">
                          {s.pinRegistered ? <span class="chip chip-primary">나만의 PIN 등록</span> : <code class="t-pin">{s.initialPin ?? "—"}</code>}
                          {locked && (
                            <span class="chip chip-danger t-ml" title={`${formatDateTime(s.lockedUntil!)}까지`}>
                              5회 틀려 잠김
                            </span>
                          )}
                        </td>
                        <td class="t-row-actions">
                          {locked && (
                            <button type="button" class="btn btn-small" onClick={() => unlock(s)} disabled={busy}>
                              잠금 풀기
                            </button>
                          )}
                          <button type="button" class="btn btn-small" onClick={() => setDialog({ kind: "edit", student: s })} aria-label={`${s.name} 수정`}>
                            수정
                          </button>
                          <button type="button" class="btn btn-small" onClick={() => setDialog({ kind: "reset", student: s })} aria-label={`${s.name} PIN 초기화`}>
                            PIN 초기화
                          </button>
                          <Link href={`/teacher/students/${s.id}`} class="btn btn-small">
                            포트폴리오
                          </Link>
                          <button
                            type="button"
                            class="btn btn-small btn-ghost t-text-danger"
                            onClick={() => setDialog({ kind: "remove", student: s })}
                            aria-label={`${s.name} 명단에서 빼기`}
                          >
                            빼기
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {filtered.length === 0 && <p class="hint t-pad">찾는 학생이 없어요.</p>}
            </div>
          </>
        ))}

      {dialog?.kind === "add" && (
        <AddStudents
          classId={c.id}
          existing={list.map((s) => s.number)}
          onClose={() => setDialog(null)}
          onAdded={(added) => {
            setDialog(null);
            mutate((all) => [...all, ...added]);
            mutateCls((x) => ({ ...x, studentCount: x.studentCount + added.length }));
            toast(`${added.length}명을 넣었어요.`);
          }}
        />
      )}
      {dialog?.kind === "edit" && (
        <EditStudent
          student={dialog.student}
          groups={groups}
          onClose={() => setDialog(null)}
          onSaved={(s) => {
            replace(s);
            setDialog(null);
            toast("학생 정보를 고쳤어요.");
          }}
        />
      )}
      {dialog?.kind === "reset" && (
        <ConfirmModal
          title="PIN 초기화"
          confirmLabel="새 초기 PIN 만들기"
          onClose={() => setDialog(null)}
          onConfirm={async () => {
            const s = await api.resetPin(dialog.student.id);
            replace(s);
            toast(`${s.name} 학생의 새 초기 PIN은 ${s.initialPin ?? "—"} 이에요.`);
          }}
        >
          <p>
            <strong>
              {dialog.student.number} {dialog.student.name}
            </strong>{" "}
            학생에게 새 초기 PIN을 만들어요.
          </p>
          <p class="muted">지금 들어와 있는 기기는 연결이 끊기고, 학생은 새 초기 PIN으로 다시 들어와 나만의 PIN을 정해야 해요. 쓴 글은 그대로예요.</p>
        </ConfirmModal>
      )}
      {dialog?.kind === "remove" && (
        <ConfirmModal
          title="명단에서 빼기"
          confirmLabel="명단에서 빼기"
          danger
          onClose={() => setDialog(null)}
          onConfirm={async () => {
            await api.deleteStudent(dialog.student.id);
            mutate((all) => all.filter((x) => x.id !== dialog.student.id));
            mutateCls((x) => ({ ...x, studentCount: Math.max(0, x.studentCount - 1) }));
            toast(`${dialog.student.name} 학생을 명단에서 뺐어요.`);
          }}
        >
          <p>
            <strong>
              {dialog.student.number} {dialog.student.name}
            </strong>{" "}
            학생을 이 반 명단에서 뺄까요?
          </p>
          <p class="muted">이 학생은 더 이상 보드에 들어올 수 없어요. 이미 쓴 카드는 보드에 남아요.</p>
        </ConfirmModal>
      )}
      {dialog?.kind === "rename" && (
        <RenameClass
          cls={c}
          onClose={() => setDialog(null)}
          onSaved={(n) => {
            mutateCls(() => n);
            setDialog(null);
            toast("반 이름을 바꿨어요.");
          }}
        />
      )}
      {dialog?.kind === "delete" &&
        (c.boardCount > 0 ? (
          <Modal title="반 지우기" onClose={() => setDialog(null)}>
            <div class="stack">
              <p>
                이 반은 보드 {c.boardCount}개에서 쓰고 있어서 지울 수 없어요. 먼저 그 보드의 설정에서 다른 반을 고르거나 보드를 지워 주세요.
              </p>
              <div class="row t-end">
                <Link href="/teacher" class="btn">
                  보드 목록 보기
                </Link>
                <button type="button" class="btn btn-primary" onClick={() => setDialog(null)}>
                  알겠어요
                </button>
              </div>
            </div>
          </Modal>
        ) : (
          <TypeToConfirm
            title="반 지우기"
            expected={c.name}
            actionLabel="반 지우기"
            description={
              <p>
                <strong>{c.name}</strong> 반과 학생 {list.length}명의 명단이 지워져요. 되돌릴 수 없어요.
              </p>
            }
            onClose={() => setDialog(null)}
            onConfirm={async () => {
              await api.deleteClass(c.id);
              toast("반을 지웠어요.");
              go("/teacher/classes");
            }}
          />
        ))}
    </div>
  );
}

function AddStudents(props: { classId: string; existing: string[]; onClose: () => void; onAdded: (s: TeacherStudent[]) => void }) {
  const [rows, setRows] = useState<StudentRowInput[]>([]);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: JSX.TargetedEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!ready) return setError(rows.length ? "고칠 줄이 있어요. 빨간 줄을 고쳐 주세요." : "넣을 학생이 없어요.");
    setBusy(true);
    setError(null);
    try {
      props.onAdded(await api.addStudents(props.classId, rows));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="학생 추가" onClose={props.onClose} busy={busy} wide>
      <form class="stack" onSubmit={submit} noValidate>
        <RosterImport
          idPrefix="as"
          existingNumbers={props.existing}
          onChange={(v, ok) => {
            setRows(v);
            setReady(ok);
            setError(null);
          }}
        />
        {error && (
          <p class="error-text" role="alert">
            {error}
          </p>
        )}
        <div class="row t-end">
          <button type="button" class="btn" onClick={props.onClose} disabled={busy}>
            취소
          </button>
          <button type="submit" class="btn btn-primary" disabled={busy || !ready}>
            {busy ? "넣는 중…" : rows.length ? `${rows.length}명 넣기` : "넣기"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function EditStudent(props: { student: TeacherStudent; groups: string[]; onClose: () => void; onSaved: (s: TeacherStudent) => void }) {
  const s = props.student;
  const [f, setF] = useState({ number: s.number, name: s.name, group: s.group, nickname: s.nickname });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: JSX.TargetedEvent<HTMLFormElement>) => {
    e.preventDefault();
    const number = f.number.trim();
    if (!/^\d{1,20}$/.test(number)) return setError("학번은 숫자 1~20자리로 써 주세요.");
    if (!f.name.trim()) return setError("이름을 입력해 주세요.");
    const patch: Record<string, string> = {};
    if (number !== s.number) patch.number = number;
    if (f.name.trim() !== s.name) patch.name = f.name.trim();
    if (f.group.trim() !== s.group) patch.group = f.group.trim();
    if (f.nickname.trim() !== s.nickname) patch.nickname = f.nickname.trim();
    if (!Object.keys(patch).length) return props.onClose();
    setBusy(true);
    setError(null);
    try {
      props.onSaved(await api.updateStudent(s.id, patch));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const set = (k: keyof typeof f) => (e: JSX.TargetedEvent<HTMLInputElement>) => setF((x) => ({ ...x, [k]: e.currentTarget.value }));
  return (
    <Modal title="학생 정보 고치기" onClose={props.onClose} busy={busy}>
      <form class="stack" onSubmit={submit} noValidate>
        <div class="t-grid2">
          <div class="field">
            <label for="es-number">학번</label>
            <input id="es-number" class="input" inputMode="numeric" maxLength={LIMITS.studentNumber} value={f.number} onInput={set("number")} />
          </div>
          <div class="field">
            <label for="es-name">이름</label>
            <input id="es-name" class="input" maxLength={LIMITS.studentName} value={f.name} data-autofocus onInput={set("name")} />
          </div>
          <div class="field">
            <label for="es-group">모둠</label>
            <input id="es-group" class="input" list="es-groups" maxLength={LIMITS.groupName} value={f.group} placeholder="예: 1모둠" onInput={set("group")} />
            <datalist id="es-groups">
              {props.groups.map((g) => (
                <option key={g} value={g} />
              ))}
            </datalist>
          </div>
          <div class="field">
            <label for="es-nick">닉네임</label>
            <input id="es-nick" class="input" maxLength={LIMITS.nickname} value={f.nickname} onInput={set("nickname")} />
          </div>
        </div>
        <p class="hint">모둠을 바꾸면 모둠별 보드에서 그 학생의 카드가 새 모둠 열로 옮겨져요.</p>
        {error && (
          <p class="error-text" role="alert">
            {error}
          </p>
        )}
        <div class="row t-end">
          <button type="button" class="btn" onClick={props.onClose} disabled={busy}>
            취소
          </button>
          <button type="submit" class="btn btn-primary" disabled={busy}>
            {busy ? "저장하는 중…" : "저장"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function RenameClass(props: { cls: ClassSummary; onClose: () => void; onSaved: (c: ClassSummary) => void }) {
  const [name, setName] = useState(props.cls.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: JSX.TargetedEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!name.trim()) return setError("반 이름을 입력해 주세요.");
    setBusy(true);
    try {
      props.onSaved(await api.renameClass(props.cls.id, name.trim()));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="반 이름 바꾸기" onClose={props.onClose} busy={busy}>
      <form class="stack" onSubmit={submit}>
        <div class="field">
          <label for="rc-name">반 이름</label>
          <input id="rc-name" class="input" maxLength={LIMITS.className} value={name} data-autofocus onInput={(e) => setName(e.currentTarget.value)} />
        </div>
        {error && (
          <p class="error-text" role="alert">
            {error}
          </p>
        )}
        <div class="row t-end">
          <button type="button" class="btn" onClick={props.onClose} disabled={busy}>
            취소
          </button>
          <button type="submit" class="btn btn-primary" disabled={busy}>
            저장
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function ConfirmModal(props: {
  title: string;
  confirmLabel: string;
  danger?: boolean;
  children: ComponentChildren;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}) {
  const [busy, run] = useAction();
  return (
    <Modal title={props.title} onClose={props.onClose} busy={busy}>
      <div class="stack">
        {props.children}
        <div class="row t-end">
          <button type="button" class="btn" onClick={props.onClose} disabled={busy}>
            취소
          </button>
          <button
            type="button"
            class={props.danger ? "btn btn-danger-solid" : "btn btn-primary"}
            disabled={busy}
            data-autofocus
            onClick={() =>
              run(async () => {
                await props.onConfirm();
                props.onClose();
              })
            }
          >
            {busy ? "처리하는 중…" : props.confirmLabel}
          </button>
        </div>
      </div>
    </Modal>
  );
}
