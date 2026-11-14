import { useEffect, useRef, useState } from "preact/hooks";
import { LIMITS } from "../../src/shared/protocol";
import { Modal } from "../ui/Modal";
import { confirmDialog } from "../ui/ConfirmDialog";
import { useBoard, useView } from "./ctx";
import { formatTime, Linkified } from "./format";

const PAGE = 30;

/** 댓글 보기·쓰기. 많으면 최근 30개부터 보이고 "이전 댓글 더 보기"로 늘린다. */
export function Comments(props: { postId: string; onClose: () => void }) {
  const ctx = useBoard();
  const post = useView((v) => v.posts[props.postId]);
  const settings = useView((v) => v.settings);
  const [shown, setShown] = useState(PAGE);
  const [text, setText] = useState("");
  const listRef = useRef<HTMLOListElement>(null);
  const count = post?.comments.length ?? 0;
  const prevCount = useRef(count);

  // 새 댓글이 오면 맨 아래로 (내가 쓴 것 포함)
  useEffect(() => {
    if (count > prevCount.current) {
      const el = listRef.current;
      el?.lastElementChild?.scrollIntoView({ block: "nearest" });
    }
    prevCount.current = count;
  }, [count]);

  useEffect(() => {
    if (!post) props.onClose();
  }, [!post]);
  if (!post) return null;

  const teacher = ctx.role === "teacher";
  const canWrite = settings.allowComments && (teacher || !settings.locked) && !settings.archived && (teacher || post.status === "visible");
  const list = post.comments.slice(Math.max(0, count - shown));
  const hidden = count - list.length;

  const submit = (e: Event) => {
    e.preventDefault();
    const b = text.trim();
    if (!b) return;
    void ctx.conn.send({ t: "comment.add", postId: post.id, body: b });
    setText("");
  };

  return (
    <Modal title={`💬 댓글 ${count}개`} onClose={props.onClose} initialFocus="#comment-input" class="comments-modal">
      <p class="comments-of muted">{post.title || post.body.slice(0, 60) || "카드"}</p>
      {hidden > 0 ? (
        <button type="button" class="btn btn-small comments-more" onClick={() => setShown((n) => n + PAGE)}>
          이전 댓글 {Math.min(hidden, PAGE)}개 더 보기
        </button>
      ) : null}
      {count === 0 ? <p class="muted comments-empty">아직 댓글이 없어요. 첫 댓글을 남겨 볼까요?</p> : null}
      <ol class="comments" ref={listRef}>
        {list.map((c) => (
          <li key={c.id} class={"comment" + (c.mine ? " is-mine" : "") + (c.sending ? " is-sending" : "")}>
            <div class="comment-head">
              <strong class="comment-author">
                {teacher && c.authorNumber ? c.authorNumber + " " : ""}
                {c.authorName}
              </strong>
              <span class="hint">{c.sending ? "보내는 중…" : formatTime(c.createdAt)}</span>
              {(c.mine || teacher) && !c.sending && (teacher || !settings.locked) ? (
                <button
                  type="button"
                  class="btn btn-small btn-ghost comment-del"
                  aria-label="댓글 지우기"
                  onClick={async () => {
                    if (await confirmDialog({ title: "댓글을 지울까요?", okLabel: "지우기", danger: true }))
                      void ctx.conn.send({ t: "comment.delete", postId: post.id, commentId: c.id });
                  }}
                >
                  🗑️
                </button>
              ) : null}
            </div>
            <p class="comment-body">
              <Linkified text={c.body} />
            </p>
          </li>
        ))}
      </ol>
      {canWrite ? (
        <form class="comment-form" onSubmit={submit}>
          <label class="sr-only" for="comment-input">
            댓글 쓰기
          </label>
          <input
            id="comment-input"
            class="input"
            maxLength={LIMITS.commentBody}
            autoComplete="off"
            placeholder="따뜻한 댓글을 남겨요"
            value={text}
            onInput={(e) => setText((e.currentTarget as HTMLInputElement).value)}
          />
          <button type="submit" class="btn btn-primary" disabled={!text.trim()}>
            보내기
          </button>
        </form>
      ) : (
        <p class="hint">
          {!settings.allowComments
            ? "지금은 댓글을 쓸 수 없어요."
            : settings.locked
              ? "🔒 선생님이 보드를 잠가서 지금은 볼 수만 있어요."
              : post.status !== "visible"
                ? "선생님이 확인한 카드에만 댓글을 쓸 수 있어요."
                : ""}
        </p>
      )}
    </Modal>
  );
}
