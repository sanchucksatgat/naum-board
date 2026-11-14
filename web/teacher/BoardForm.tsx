/** 보드 만들기 / 설정 바꾸기 (같은 양식) */
import type { JSX } from "preact";
import { useState } from "preact/hooks";
import {
  LIMITS, type BoardDetail, type BoardSettingsPatch, type BoardType, type ClassSummary, type ColumnMode, type EntryMode,
} from "../../src/shared/protocol";
import { api, errorMessage } from "./api";
import { parseTopics } from "./format";
import { Link } from "./nav";
import { applyTopics } from "./topics";
import { Choice, Modal, Toggle, toast, useAsync } from "./ui";

interface FormState {
  title: string;
  description: string;
  type: BoardType;
  columnMode: ColumnMode;
  entryMode: EntryMode;
  classId: string;
  topics: string;
  moderation: boolean;
  anonymous: boolean;
  allowLikes: boolean;
  allowComments: boolean;
  locked: boolean;
  maxFileMB: number;
}

function initial(board?: BoardDetail): FormState {
  const s = board?.settings;
  return {
    title: s?.title ?? "",
    description: s?.description ?? "",
    type: s?.type ?? "cumulative",
    columnMode: s?.columnMode ?? "student",
    entryMode: s?.entryMode ?? "roster",
    classId: board?.classId ?? "",
    topics: "",
    moderation: s?.moderation ?? false,
    anonymous: s?.anonymous ?? false,
    allowLikes: s?.allowLikes ?? true,
    allowComments: s?.allowComments ?? true,
    locked: s?.locked ?? false,
    maxFileMB: s?.maxFileMB ?? LIMITS.maxFileMBDefault,
  };
}

export function BoardForm(props: { board?: BoardDetail; onClose: () => void; onSaved: (b: BoardDetail) => void }) {
  const editing = !!props.board;
  const [f, setF] = useState<FormState>(() => initial(props.board));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [classes] = useAsync<ClassSummary[]>(() => api.classes(), []);
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setF((x) => ({ ...x, [k]: v }));

  // 자유 입장 + 모둠별은 서버가 막는다 → 미리 막는다
  const setEntry = (v: EntryMode) => setF((x) => ({ ...x, entryMode: v, columnMode: v === "free" && x.columnMode === "group" ? "student" : x.columnMode }));

  const classList = classes.status === "ok" ? classes.data : [];
  const topics = parseTopics(f.topics, LIMITS.columnsPerBoard, LIMITS.columnTitle);

  const submit = async (e: JSX.TargetedEvent<HTMLFormElement>) => {
    e.preventDefault();
    const title = f.title.trim();
    if (!title) {
      setError("보드 제목을 입력해 주세요.");
      (document.getElementById("bf-title") as HTMLInputElement | null)?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const settings: BoardSettingsPatch = {
        title,
        description: f.description.trim(),
        type: f.type,
        columnMode: f.columnMode,
        entryMode: f.entryMode,
        moderation: f.moderation,
        anonymous: f.anonymous,
        allowLikes: f.allowLikes,
        allowComments: f.allowComments,
        maxFileMB: f.maxFileMB,
      };
      const classId = f.entryMode === "roster" && f.classId ? f.classId : null;
      let saved: BoardDetail;
      if (!props.board) {
        saved = await api.createBoard({ ...settings, title, classId });
        if (f.columnMode === "topic" && topics.length) {
          try {
            await applyTopics(saved.code, topics);
          } catch (err) {
            toast(errorMessage(err), "error");
          }
        }
      } else {
        const cur = props.board.settings;
        const patch: BoardSettingsPatch = { locked: f.locked !== cur.locked ? f.locked : undefined };
        for (const k of Object.keys(settings) as Array<keyof BoardSettingsPatch>) {
          if (settings[k] !== cur[k]) (patch as Record<string, unknown>)[k] = settings[k];
        }
        for (const k of Object.keys(patch) as Array<keyof BoardSettingsPatch>) if (patch[k] === undefined) delete patch[k];
        saved = props.board;
        if (Object.keys(patch).length) saved = await api.updateBoard(props.board.id, patch);
        if ((props.board.classId ?? null) !== classId && (f.entryMode === "roster" || props.board.classId)) {
          saved = await api.linkClass(props.board.id, classId);
        }
      }
      props.onSaved(saved);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const cur = props.board?.settings;
  const structureChanged = editing && cur && (cur.columnMode !== f.columnMode || cur.entryMode !== f.entryMode);

  return (
    <Modal title={editing ? "보드 설정" : "새 보드 만들기"} onClose={props.onClose} busy={busy} wide>
      <form class="stack t-form" onSubmit={submit} noValidate>
        <div class="field">
          <label for="bf-title">보드 제목</label>
          <input
            id="bf-title"
            class="input"
            maxLength={LIMITS.boardTitle}
            value={f.title}
            placeholder="예: 우리 동네 생물 관찰"
            data-autofocus
            onInput={(e) => set("title", e.currentTarget.value)}
          />
        </div>
        <div class="field">
          <label for="bf-desc">안내문 (선택)</label>
          <textarea
            id="bf-desc"
            class="textarea"
            rows={2}
            maxLength={LIMITS.boardDescription}
            value={f.description}
            placeholder="학생에게 보여 줄 활동 안내를 적어 주세요."
            onInput={(e) => set("description", e.currentTarget.value)}
          />
        </div>

        <Choice<BoardType>
          name="bf-type"
          legend="보드 유형"
          value={f.type}
          onChange={(v) => set("type", v)}
          options={[
            { value: "cumulative", label: "여러 장 누적", hint: "학생이 카드를 여러 장 올려요. 관찰 기록, 활동 모음에 좋아요." },
            { value: "single", label: "학생당 1카드", hint: "한 사람이 카드 한 장만 써요. 하나의 질문에 대한 생각 나누기에 좋아요." },
          ]}
        />

        <Choice<ColumnMode>
          name="bf-col"
          legend="열 구성"
          value={f.columnMode}
          onChange={(v) => set("columnMode", v)}
          options={[
            { value: "student", label: "개인별", hint: "학생마다 자기 열이 생겨요." },
            {
              value: "group",
              label: "모둠별",
              hint: f.entryMode === "free" ? "명단 입장에서만 쓸 수 있어요 (명단의 모둠으로 나눠요)." : "명단의 모둠마다 열이 생겨요.",
              disabled: f.entryMode === "free",
            },
            { value: "topic", label: "주제별", hint: "선생님이 정한 주제마다 열이 생기고, 학생이 주제를 골라 써요." },
          ]}
        />
        {f.columnMode === "topic" && !editing && (
          <div class="field">
            <label for="bf-topics">주제 이름 (한 줄에 하나)</label>
            <textarea
              id="bf-topics"
              class="textarea"
              rows={3}
              value={f.topics}
              placeholder={"예:\n좋았던 점\n아쉬운 점\n궁금한 점"}
              onInput={(e) => set("topics", e.currentTarget.value)}
            />
            <p class="hint">{topics.length ? `주제 ${topics.length}개: ${topics.join(" · ")}` : "비워 두면 ‘주제 1’ 하나로 시작해요. 보드 화면에서 열을 더 만들 수 있어요."}</p>
          </div>
        )}
        {f.columnMode === "topic" && editing && cur?.columnMode === "topic" && <p class="hint">주제(열) 이름은 보드 화면에서 바꾸거나 더할 수 있어요.</p>}

        <Choice<EntryMode>
          name="bf-entry"
          legend="학생 입장 방식"
          value={f.entryMode}
          onChange={setEntry}
          options={[
            { value: "roster", label: "명단 입장", hint: "학번과 PIN 4자리로 들어와요. 누가 썼는지 확실하고 미제출자를 볼 수 있어요." },
            { value: "free", label: "자유 입장", hint: "명단 없이 닉네임만 적고 들어와요. 연수·공개 수업에 좋아요." },
          ]}
        />

        {f.entryMode === "roster" && (
          <div class="field">
            <label for="bf-class">반 고르기</label>
            {classes.status === "loading" ? (
              <p class="hint">반 목록을 불러오는 중이에요…</p>
            ) : classes.status === "error" ? (
              <p class="error-text">반 목록을 불러오지 못했어요. {errorMessage(classes.error)}</p>
            ) : classList.length === 0 ? (
              <p class="hint">
                아직 만든 반이 없어요. 반 없이 만들고 나중에 연결해도 돼요. <Link href="/teacher/classes">반·명단 만들기</Link>
              </p>
            ) : (
              <>
                <select id="bf-class" class="select" value={f.classId} onChange={(e) => set("classId", e.currentTarget.value)}>
                  <option value="">나중에 고를게요</option>
                  {classList.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name} ({c.studentCount}명)
                    </option>
                  ))}
                </select>
                <p class="hint">이 반 명단의 학생만 들어올 수 있어요.{!f.classId && " 반을 고르기 전에는 학생이 들어올 수 없어요."}</p>
              </>
            )}
          </div>
        )}

        <fieldset class="t-choice">
          <legend class="label">옵션</legend>
          <div class="stack t-gap-2">
            <Toggle label="승인 후 게시" hint="학생 카드는 선생님이 승인해야 모두에게 보여요." checked={f.moderation} onChange={(v) => set("moderation", v)} />
            <Toggle label="익명 모드" hint="학생 화면에서 친구 이름이 ‘익명’으로 보여요. 선생님은 누가 썼는지 볼 수 있어요." checked={f.anonymous} onChange={(v) => set("anonymous", v)} />
            <Toggle label="좋아요 허용" hint="카드에 ♥를 누를 수 있어요." checked={f.allowLikes} onChange={(v) => set("allowLikes", v)} />
            <Toggle label="댓글 허용" hint="카드에 댓글을 달 수 있어요." checked={f.allowComments} onChange={(v) => set("allowComments", v)} />
            {editing && <Toggle label="보드 잠금" hint="학생은 읽기만 하고 아무것도 쓸 수 없어요." checked={f.locked} onChange={(v) => set("locked", v)} />}
          </div>
        </fieldset>

        <details class="t-details">
          <summary>자세한 설정</summary>
          <div class="field">
            <label for="bf-max">첨부 파일 한 개 최대 크기 (MB)</label>
            <input
              id="bf-max"
              class="input t-narrow"
              type="number"
              inputMode="numeric"
              min={LIMITS.maxFileMBMin}
              max={LIMITS.maxFileMBMax}
              value={f.maxFileMB}
              onInput={(e) => {
                const n = Math.round(Number(e.currentTarget.value));
                if (Number.isFinite(n)) set("maxFileMB", Math.min(LIMITS.maxFileMBMax, Math.max(LIMITS.maxFileMBMin, n)));
              }}
            />
            <p class="hint">사진은 올리기 전에 자동으로 줄여요. 보통은 바꾸지 않아도 돼요.</p>
          </div>
        </details>

        {structureChanged && <p class="t-warnbox">열 구성이나 입장 방식을 바꾸면 보드가 새로 정리되고, 입장 방식을 바꾸면 학생들이 다시 들어와야 해요.</p>}
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
            {busy ? "저장하는 중…" : editing ? "설정 저장" : "보드 만들기"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** 이름만 바꾸기 */
export function RenameBoard(props: { board: BoardDetail; onClose: () => void; onSaved: (b: BoardDetail) => void }) {
  const [title, setTitle] = useState(props.board.title);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: JSX.TargetedEvent<HTMLFormElement>) => {
    e.preventDefault();
    const t = title.trim();
    if (!t) return setError("보드 이름을 입력해 주세요.");
    setBusy(true);
    try {
      props.onSaved(await api.updateBoard(props.board.id, { title: t }));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="보드 이름 바꾸기" onClose={props.onClose} busy={busy}>
      <form class="stack" onSubmit={submit}>
        <div class="field">
          <label for="rn-title">새 이름</label>
          <input id="rn-title" class="input" maxLength={LIMITS.boardTitle} value={title} data-autofocus onInput={(e) => setTitle(e.currentTarget.value)} />
          <p class="hint">입장 코드와 학생 글은 그대로예요. 드라이브 폴더 이름도 함께 바뀌어요.</p>
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
            {busy ? "저장하는 중…" : "이름 저장"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
