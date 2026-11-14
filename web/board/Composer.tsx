import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { LIMITS, type AttachmentRef, type PostInput } from "../../src/shared/protocol";
import { IMAGE_MIME } from "../../src/shared/files";
import { uploadAttachment, UploadError } from "../lib/upload";
import type { ViewAttachment } from "../lib/realtime";
import { Modal } from "../ui/Modal";
import { confirmDialog } from "../ui/ConfirmDialog";
import { toast } from "../ui/Toast";
import { fileUrl, useBoard, type ComposeTarget } from "./ctx";
import { fileIcon, formatSize, isHttpUrl } from "./format";

interface Item {
  key: string;
  /** 기존 첨부 id (고칠 때) */
  id?: string;
  view: ViewAttachment;
  status: "uploading" | "done" | "error";
  progress: number;
  phase?: string;
  token?: string;
  error?: string;
  abort?: AbortController;
  file?: File;
}

interface Draft {
  title: string;
  body: string;
  link: string;
  columnId?: string;
  onBehalfOf?: string;
}

/** 보내기에 실패한 글 (다시 열면 되살림). 보드별, 이 화면이 열려 있는 동안만 */
const failedDrafts = new Map<string, Draft>();

let keySeq = 0;

const isTouch = () => typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;

export function Composer(props: { target: ComposeTarget; onClose: () => void }) {
  const ctx = useBoard();
  const v = ctx.conn.getState().view!;
  const editing = props.target.editId ? v.posts[props.target.editId] : undefined;
  const draftKey = ctx.code + "|" + (props.target.editId ?? "new");
  const restored = !editing ? failedDrafts.get(draftKey) : undefined;

  const [title, setTitle] = useState(editing?.title ?? restored?.title ?? "");
  const [body, setBody] = useState(editing?.body ?? restored?.body ?? "");
  const [link, setLink] = useState(editing?.link ?? restored?.link ?? "");
  const [showLink, setShowLink] = useState(!!(editing?.link || restored?.link));
  const [columnId, setColumnId] = useState(props.target.columnId ?? editing?.columnId ?? restored?.columnId ?? v.columns[0]?.id ?? "");
  const [onBehalfOf, setOnBehalfOf] = useState(props.target.onBehalfOf ?? restored?.onBehalfOf ?? "");
  const [items, setItems] = useState<Item[]>(() =>
    (editing?.attachments ?? []).map((a) => ({ key: "k" + ++keySeq, id: a.id, view: a, status: "done" as const, progress: 1 })),
  );
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const galleryRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (restored) toast("보내지 못한 글을 다시 불러왔어요.");
    return () => {
      // 닫힐 때 아직 올리는 중인 파일은 멈춘다
      for (const it of itemsRef.current) if (it.status === "uploading") it.abort?.abort();
    };
  }, []);

  const s = v.settings;
  const topic = s.columnMode === "topic";
  const teacher = ctx.role === "teacher";
  const roster = teacher && s.entryMode === "roster" && !editing ? (v.roster ?? []).filter((r) => r.kind === "roster") : [];
  const maxBytes = s.maxFileMB * 1024 * 1024;
  const uploading = items.some((i) => i.status === "uploading");
  const dirty = !!(title.trim() || body.trim() || link.trim() || items.some((i) => !i.id));
  const changed = editing
    ? title !== editing.title || body !== editing.body || link !== editing.link || items.length !== editing.attachments.length || items.some((i) => !i.id)
    : dirty;

  const patch = (key: string, fn: (it: Item) => Item) => setItems((list) => list.map((it) => (it.key === key ? fn(it) : it)));

  const addFiles = (files: File[]) => {
    setError(null);
    const room = LIMITS.attachmentsPerPost - itemsRef.current.length;
    if (room <= 0) {
      setError(`사진·파일은 ${LIMITS.attachmentsPerPost}개까지 넣을 수 있어요.`);
      return;
    }
    if (files.length > room) toast(`${LIMITS.attachmentsPerPost}개까지만 넣을 수 있어서 ${room}개만 넣었어요.`);
    for (const file of files.slice(0, room)) {
      const isImg = IMAGE_MIME.has(file.type) || file.type === "image/heic" || file.type === "image/heif";
      // 사진은 줄여서 올리므로 원본 크기로 막지 않는다
      if (!isImg && file.size > maxBytes) {
        toast(`"${file.name}" 파일이 너무 커요. ${s.maxFileMB}MB까지 올릴 수 있어요.`, { kind: "error" });
        continue;
      }
      const key = "k" + ++keySeq;
      const abort = new AbortController();
      const previewUrl = isImg && file.type !== "image/heic" && file.type !== "image/heif" ? URL.createObjectURL(file) : undefined;
      const item: Item = {
        key,
        view: { id: "tmp:" + key, name: file.name || "사진", mime: file.type || "application/octet-stream", size: file.size, kind: isImg ? "image" : "file", previewUrl },
        status: "uploading",
        progress: 0,
        phase: "준비 중",
        abort,
        file,
      };
      setItems((list) => [...list, item]);
      void startUpload(key, file, abort);
    }
  };

  const startUpload = async (key: string, file: File, abort: AbortController) => {
    try {
      const r = await uploadAttachment(ctx.code, file, {
        signal: abort.signal,
        onProgress: (p) =>
          patch(key, (it) => ({
            ...it,
            progress: p.phase === "upload" ? p.fraction : p.phase === "verify" ? 1 : 0,
            phase: p.phase === "compress" ? "사진 줄이는 중" : p.phase === "verify" ? "확인 중" : "올리는 중",
          })),
      });
      patch(key, (it) => ({
        ...it,
        status: "done",
        progress: 1,
        token: r.token,
        view: {
          ...it.view,
          name: r.file.name,
          mime: r.file.mime,
          size: r.file.size,
          kind: r.file.kind,
          ...(r.file.width ? { width: r.file.width } : {}),
          ...(r.file.height ? { height: r.file.height } : {}),
        },
      }));
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return;
      const msg = e instanceof UploadError ? e.message : "파일을 올리지 못했어요.";
      patch(key, (it) => ({ ...it, status: "error", error: msg }));
    }
  };

  const remove = (key: string) => {
    const it = itemsRef.current.find((x) => x.key === key);
    it?.abort?.abort();
    setItems((list) => list.filter((x) => x.key !== key));
  };

  const retry = (key: string) => {
    const it = itemsRef.current.find((x) => x.key === key);
    if (!it?.file) return;
    const abort = new AbortController();
    patch(key, (x) => ({ ...x, status: "uploading", progress: 0, error: undefined, abort }));
    void startUpload(key, it.file, abort);
  };

  const move = (key: string, d: number) =>
    setItems((list) => {
      const i = list.findIndex((x) => x.key === key);
      const j = i + d;
      if (i < 0 || j < 0 || j >= list.length) return list;
      const next = list.slice();
      [next[i], next[j]] = [next[j]!, next[i]!];
      return next;
    });

  const close = async () => {
    if (changed && !(await confirmDialog({ title: "쓰던 글을 버릴까요?", message: "지금 닫으면 쓴 내용이 없어져요.", okLabel: "버리기", cancelLabel: "계속 쓰기", danger: true }))) return;
    failedDrafts.delete(draftKey);
    props.onClose();
  };

  const submit = (e?: Event) => {
    e?.preventDefault();
    setError(null);
    if (uploading) return setError("사진·파일을 다 올릴 때까지 기다려 주세요.");
    if (items.some((i) => i.status === "error")) return setError("올리지 못한 파일이 있어요. 다시 올리거나 빼 주세요.");
    const t = title.trim();
    const b = body.trim();
    const l = link.trim();
    if (l && !isHttpUrl(l)) return setError("링크는 https:// 로 시작하는 주소를 넣어 주세요.");
    if (!t && !b && !l && items.length === 0) return setError("제목이나 내용을 써 주세요.");
    if (topic && !columnId) return setError("카드를 놓을 칸을 골라 주세요.");

    const refs: AttachmentRef[] = items.map((i) => (i.id ? { id: i.id } : { uploadToken: i.token! }));
    const views: ViewAttachment[] = items.map((i) => i.view);
    const post: PostInput = { title: t, body: b, link: l };
    if (editing) {
      post.id = editing.id;
      if (topic && columnId !== editing.columnId) post.columnId = columnId;
      const sameAtts = refs.length === editing.attachments.length && items.every((i, n) => i.id === editing.attachments[n]?.id);
      if (!sameAtts) post.attachments = refs;
    } else {
      if (topic) post.columnId = columnId;
      if (refs.length) post.attachments = refs;
      if (onBehalfOf) post.onBehalfOf = onBehalfOf;
    }
    const draft: Draft = { title, body, link, columnId, onBehalfOf };
    failedDrafts.delete(draftKey);
    ctx.conn
      .send({ t: "post.save", post }, { attachments: views })
      .then(() => {
        // 미리보기 주소는 서버 사진이 뜬 뒤 정리
        setTimeout(() => views.forEach((a) => a.previewUrl && URL.revokeObjectURL(a.previewUrl)), 120_000);
      })
      .catch(() => {
        if (!editing) failedDrafts.set(draftKey, draft);
      });
    props.onClose();
  };

  const onPaste = (e: ClipboardEvent) => {
    const files = Array.from(e.clipboardData?.files ?? []);
    if (files.length) {
      e.preventDefault();
      addFiles(files);
    }
  };

  const touch = useMemo(isTouch, []);
  const heading = editing ? (editing.mine ? "내 카드 고치기" : "카드 고치기") : onBehalfOf ? "학생 대신 쓰기" : "새 카드 쓰기";

  return (
    <Modal
      title={heading}
      onClose={() => void close()}
      persistent={changed}
      initialFocus="#composer-title"
      class={"composer" + (dragging ? " is-dragging" : "")}
      footer={
        <>
          <button type="button" class="btn" onClick={() => void close()}>
            취소
          </button>
          <button type="submit" form="composer-form" class="btn btn-primary composer-send" disabled={uploading}>
            {uploading ? "올리는 중…" : editing ? "고친 내용 저장" : "올리기"}
          </button>
        </>
      }
    >
      <form
        id="composer-form"
        class="stack composer-form"
        onSubmit={submit}
        onPaste={onPaste}
        onDragOver={(e) => {
          if (e.dataTransfer?.types.includes("Files")) {
            e.preventDefault();
            setDragging(true);
          }
        }}
        onDragLeave={(e) => {
          if (e.currentTarget === e.target) setDragging(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          addFiles(Array.from(e.dataTransfer?.files ?? []));
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) submit(e);
        }}
      >
        {roster.length ? (
          <div class="field">
            <label for="composer-who">누구 이름으로 쓸까요?</label>
            <select id="composer-who" class="select" value={onBehalfOf} onChange={(e) => setOnBehalfOf((e.currentTarget as HTMLSelectElement).value)}>
              <option value="">선생님 (나)</option>
              {roster.map((r) => (
                <option key={r.ref} value={r.ref}>
                  {r.number} {r.name}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        {topic ? (
          <div class="field">
            <label for="composer-col">어느 칸에 놓을까요?</label>
            <select id="composer-col" class="select" value={columnId} onChange={(e) => setColumnId((e.currentTarget as HTMLSelectElement).value)}>
              {v.columns.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.title}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        <div class="field">
          <label for="composer-title">제목</label>
          <input
            id="composer-title"
            class="input"
            maxLength={LIMITS.postTitle}
            value={title}
            placeholder="제목 (안 써도 돼요)"
            autoComplete="off"
            onInput={(e) => setTitle((e.currentTarget as HTMLInputElement).value)}
          />
        </div>
        <div class="field">
          <label for="composer-body">내용</label>
          <textarea
            id="composer-body"
            class="textarea composer-body"
            maxLength={LIMITS.postBody}
            value={body}
            placeholder="생각을 자유롭게 써 보세요"
            rows={5}
            onInput={(e) => setBody((e.currentTarget as HTMLTextAreaElement).value)}
          />
          {body.length > LIMITS.postBody - 300 ? (
            <span class="hint">
              {body.length} / {LIMITS.postBody}자
            </span>
          ) : null}
        </div>

        {showLink ? (
          <div class="field">
            <label for="composer-link">링크 주소</label>
            <input
              id="composer-link"
              class="input"
              type="url"
              inputMode="url"
              maxLength={LIMITS.postLink}
              value={link}
              placeholder="https://"
              autoComplete="off"
              onInput={(e) => setLink((e.currentTarget as HTMLInputElement).value)}
            />
          </div>
        ) : null}

        {items.length ? (
          <ul class="composer-items" aria-label="넣은 사진·파일">
            {items.map((it, i) => (
              <li key={it.key} class={"composer-item is-" + it.status}>
                <span class="composer-thumb" aria-hidden="true">
                  {it.view.kind === "image" && (it.view.previewUrl || it.id) ? (
                    <img src={it.view.previewUrl ?? fileUrl(v, it.id!)} alt="" width={56} height={56} />
                  ) : (
                    <span>{fileIcon(it.view.mime)}</span>
                  )}
                </span>
                <span class="composer-item-info">
                  <span class="composer-item-name">{it.view.name}</span>
                  {it.status === "uploading" ? (
                    <span class="composer-progress" role="progressbar" aria-label={`${it.view.name} ${it.phase}`} aria-valuenow={Math.round(it.progress * 100)} aria-valuemin={0} aria-valuemax={100}>
                      <span class="composer-progress-bar" style={{ width: `${Math.max(4, it.progress * 100)}%` }} />
                      <span class="hint">
                        {it.phase} {it.phase === "올리는 중" ? Math.round(it.progress * 100) + "%" : ""}
                      </span>
                    </span>
                  ) : it.status === "error" ? (
                    <span class="error-text">{it.error}</span>
                  ) : (
                    <span class="hint">{it.id ? "올려 둔 파일" : "다 올렸어요 · " + formatSize(it.view.size)}</span>
                  )}
                </span>
                <span class="composer-item-btns">
                  {it.status === "error" && it.file ? (
                    <button type="button" class="btn btn-small" onClick={() => retry(it.key)}>
                      다시
                    </button>
                  ) : null}
                  {items.length > 1 && i > 0 ? (
                    <button type="button" class="btn btn-small btn-ghost" aria-label={`${it.view.name} 앞으로`} onClick={() => move(it.key, -1)}>
                      ↑
                    </button>
                  ) : null}
                  <button type="button" class="btn btn-small btn-ghost" aria-label={`${it.view.name} 빼기`} onClick={() => remove(it.key)}>
                    ✕
                  </button>
                </span>
              </li>
            ))}
          </ul>
        ) : null}

        <div class="composer-tools">
          {touch ? (
            <button type="button" class="btn" onClick={() => cameraRef.current?.click()}>
              📷 사진 찍기
            </button>
          ) : null}
          <button type="button" class="btn" onClick={() => galleryRef.current?.click()}>
            🖼️ {touch ? "사진·파일 고르기" : "사진·파일 넣기"}
          </button>
          {!showLink ? (
            <button type="button" class="btn" onClick={() => setShowLink(true)}>
              🔗 링크 넣기
            </button>
          ) : null}
          <input
            ref={cameraRef}
            type="file"
            accept="image/*"
            capture="environment"
            class="sr-only"
            tabIndex={-1}
            aria-hidden="true"
            onChange={(e) => {
              const el = e.currentTarget as HTMLInputElement;
              addFiles(Array.from(el.files ?? []));
              el.value = "";
            }}
          />
          <input
            ref={galleryRef}
            type="file"
            multiple
            class="sr-only"
            tabIndex={-1}
            aria-hidden="true"
            onChange={(e) => {
              const el = e.currentTarget as HTMLInputElement;
              addFiles(Array.from(el.files ?? []));
              el.value = "";
            }}
          />
        </div>
        {!touch ? <p class="hint composer-drop-hint">사진을 여기로 끌어 놓거나 붙여 넣어도(Ctrl+V) 돼요.</p> : null}
        {!teacher && s.moderation ? <p class="hint">⏳ 선생님이 확인한 뒤에 친구들에게 보여요.</p> : null}
        {error ? (
          <p class="error-text" role="alert">
            {error}
          </p>
        ) : null}
      </form>
    </Modal>
  );
}
