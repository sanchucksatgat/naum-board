import { Component } from "preact";
import type { BoardSettings } from "../../src/shared/protocol";
import type { ViewAttachment, ViewPost } from "../lib/realtime";
import { confirmDialog } from "../ui/ConfirmDialog";
import { openImageViewer } from "../ui/ImageViewer";
import { fileUrl, useBoard, useView } from "./ctx";
import { fileIcon, formatSize, formatTime, hostOf, Linkified } from "./format";

/**
 * 카드 하나. 자기 카드 객체만 구독하므로 다른 카드가 바뀌어도 다시 그려지지 않는다.
 * CardShell 은 id 가 같으면 부모(열)가 다시 그려져도 건너뛴다.
 */
export class CardShell extends Component<{ id: string; showAuthor: boolean }> {
  override shouldComponentUpdate(next: { id: string; showAuthor: boolean }) {
    return next.id !== this.props.id || next.showAuthor !== this.props.showAuthor;
  }
  render() {
    return <Card id={this.props.id} showAuthor={this.props.showAuthor} />;
  }
}

function Card(props: { id: string; showAuthor: boolean }) {
  const ctx = useBoard();
  const post = useView((v) => v.posts[props.id]);
  const settings = useView((v) => v.settings);
  const files = useView(
    (v) => ({ board: v.board, fileToken: v.fileToken }),
    (a, b) => a.fileToken === b.fileToken && a.board === b.board,
  );
  if (!post) return null;
  if (ctx.projector && post.status !== "visible") return null;

  const teacher = ctx.role === "teacher";
  const temp = post.id.startsWith("tmp:");
  const studentLocked = !teacher && settings.locked;
  const canEdit = !ctx.projector && !temp && (post.mine || teacher) && !studentLocked;
  const T = ctx.teacher;
  const images = post.attachments.filter((a) => a.kind === "image");
  const others = post.attachments.filter((a) => a.kind !== "image");
  const urlFor = (a: ViewAttachment) => a.previewUrl ?? (a.id.startsWith("tmp:") ? "" : fileUrl(files, a.id));
  const hideName = ctx.projector && ctx.hideNames;

  const label = post.title || post.body.slice(0, 30) || "카드";
  return (
    <article
      class={
        "bcard card" +
        (post.status !== "visible" ? " is-" + post.status : "") +
        (post.mine ? " is-mine" : "") +
        (post.sending ? " is-sending" : "")
      }
      aria-label={label}
      data-post={post.id}
    >
      {post.status === "pending" ? (
        <p class="bcard-status chip chip-warn">
          ⏳ {teacher ? "승인을 기다리는 카드" : "선생님이 확인하면 친구들에게 보여요"}
        </p>
      ) : post.status === "hidden" ? (
        <p class="bcard-status chip chip-danger">🙈 {teacher ? "숨긴 카드 (학생에게 안 보임)" : "선생님이 숨겼어요. 나와 선생님만 보여요"}</p>
      ) : null}

      {images.length ? <CardImages post={post} images={images} urlFor={urlFor} /> : null}

      <div class="bcard-body">
        {post.title ? <h3 class="bcard-title">{post.title}</h3> : null}
        {post.body ? (
          <p class="bcard-text">
            <Linkified text={post.body} />
          </p>
        ) : null}
        {post.link ? (
          <a class="bcard-link" href={post.link} target="_blank" rel="noopener noreferrer nofollow">
            <span aria-hidden="true">🔗</span> <span class="bcard-link-host">{hostOf(post.link)}</span>
          </a>
        ) : null}
        {others.length ? (
          <ul class="bcard-files">
            {others.map((a) => (
              <li key={a.id}>
                {urlFor(a) ? (
                  <a class="bcard-file" href={urlFor(a)} target="_blank" rel="noopener noreferrer">
                    <span aria-hidden="true">{fileIcon(a.mime)}</span>
                    <span class="bcard-file-name">{a.name}</span>
                    <span class="bcard-file-size">{formatSize(a.size)}</span>
                  </a>
                ) : (
                  <span class="bcard-file">
                    <span aria-hidden="true">{fileIcon(a.mime)}</span>
                    <span class="bcard-file-name">{a.name}</span>
                  </span>
                )}
              </li>
            ))}
          </ul>
        ) : null}

        {post.feedback && !ctx.projector ? (
          <div class="bcard-feedback">
            <strong>📝 선생님 피드백</strong>
            <p>{post.feedback.body}</p>
            {!teacher ? <span class="hint">선생님과 나만 볼 수 있어요</span> : null}
          </div>
        ) : null}

        <p class="bcard-meta">
          {props.showAuthor && !hideName ? (
            <span class="bcard-author">
              {teacher && post.authorNumber ? post.authorNumber + " " : ""}
              {post.authorName}
            </span>
          ) : null}
          <span>{post.sending ? "보내는 중…" : formatTime(post.createdAt)}</span>
          {post.updatedAt > post.createdAt + 1000 && !post.sending ? <span>· 고침</span> : null}
        </p>
      </div>

      {ctx.projector ? (
        post.likeCount || post.comments.length ? (
          <p class="bcard-meta bcard-proj-counts">
            {settings.allowLikes && post.likeCount ? <span>❤️ {post.likeCount}</span> : null}
            {settings.allowComments && post.comments.length ? <span>💬 {post.comments.length}</span> : null}
          </p>
        ) : null
      ) : (
        <div class="bcard-actions">
          <div class="row bcard-actions-main">
            {settings.allowLikes ? <LikeButton post={post} disabled={temp || studentLocked || post.status !== "visible"} /> : null}
            {settings.allowComments || post.comments.length ? (
              <button
                type="button"
                class={"btn btn-small btn-ghost bcard-btn"}
                disabled={temp}
                aria-label={`댓글 ${post.comments.length}개 보기`}
                onClick={() => ctx.openComments(post.id)}
              >
                💬 <span>{post.comments.length}</span>
              </button>
            ) : null}
          </div>
          {canEdit ? <OwnerActions post={post} settings={settings} /> : null}
        </div>
      )}
      {T && !ctx.projector && !temp ? <T.CardActions postId={post.id} /> : null}
    </article>
  );
}

function CardImages(props: { post: ViewPost; images: ViewAttachment[]; urlFor: (a: ViewAttachment) => string }) {
  const { images, urlFor } = props;
  const open = (i: number) =>
    openImageViewer(
      images.filter((a) => urlFor(a)).map((a) => ({ src: urlFor(a), alt: a.name, width: a.width, height: a.height })),
      i,
    );
  const one = images.length === 1;
  return (
    <div class={"bcard-images" + (one ? " is-one" : "")}>
      {images.slice(0, 4).map((a, i) => {
        const src = urlFor(a);
        const w = a.width && a.height ? a.width : 4;
        const h = a.width && a.height ? a.height : 3;
        const more = i === 3 && images.length > 4 ? images.length - 4 : 0;
        return (
          <button
            key={a.id}
            type="button"
            class="bcard-img-btn"
            aria-label={`사진 크게 보기: ${a.name}`}
            onClick={() => src && open(i)}
            style={one ? { aspectRatio: `${w} / ${h}` } : undefined}
          >
            {src ? <img src={src} alt={a.name} loading="lazy" decoding="async" width={w} height={h} class="bcard-img" /> : <span class="bcard-img-ph" />}
            {more ? <span class="bcard-img-more">+{more}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

function LikeButton(props: { post: ViewPost; disabled: boolean }) {
  const { conn } = useBoard();
  const p = props.post;
  return (
    <button
      type="button"
      class={"btn btn-small btn-ghost bcard-btn bcard-like" + (p.likedByMe ? " is-on" : "")}
      aria-pressed={p.likedByMe}
      aria-label={`좋아요 ${p.likeCount}개${p.likedByMe ? ", 내가 눌렀어요" : ""}`}
      disabled={props.disabled}
      onClick={() => void conn.send({ t: "like.set", postId: p.id, liked: !p.likedByMe })}
    >
      {p.likedByMe ? "❤️" : "🤍"} <span>{p.likeCount}</span>
    </button>
  );
}

function OwnerActions(props: { post: ViewPost; settings: BoardSettings }) {
  const ctx = useBoard();
  const p = props.post;
  if (!p.mine && ctx.role !== "teacher") return null;
  return (
    <div class="row bcard-own">
      <button type="button" class="btn btn-small btn-ghost bcard-btn" onClick={() => ctx.openComposer({ editId: p.id })} aria-label={p.mine ? "내 카드 고치기" : "카드 고치기"}>
        ✏️ <span class="bcard-btn-text">고치기</span>
      </button>
      <button
        type="button"
        class="btn btn-small btn-ghost bcard-btn"
        aria-label={p.mine ? "내 카드 지우기" : "카드 지우기"}
        onClick={async () => {
          if (await confirmDialog({ title: "이 카드를 지울까요?", message: "지우면 댓글과 좋아요도 함께 없어져요.", okLabel: "지우기", danger: true }))
            void ctx.conn.send({ t: "post.delete", postId: p.id });
        }}
      >
        🗑️ <span class="bcard-btn-text">지우기</span>
      </button>
    </div>
  );
}
