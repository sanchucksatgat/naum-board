/** 내 보드 목록 (만든 보드 / 보관함), 검색, 새 보드, 최근 올라온 글 */
import { useEffect, useState } from "preact/hooks";
import type { BoardDetail, BoardSummary, RecentPost } from "../../src/shared/protocol";
import { api } from "./api";
import { BoardForm } from "./BoardForm";
import { COLUMN_LABEL, ENTRY_LABEL, TYPE_LABEL, matchesBoard, relativeTime, sortBoards, spacedCode } from "./format";
import { Link, go } from "./nav";
import { ShareModal } from "./Share";
import { Empty, ErrorBox, Loading, useAsync } from "./ui";

export function Dashboard(props: { view: "active" | "archived" }) {
  const [boards, reload] = useAsync(() => api.boards("all"), []);
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [sharing, setSharing] = useState<BoardSummary | null>(null);
  const archivedView = props.view === "archived";

  useEffect(() => {
    document.title = (archivedView ? "보관함" : "내 보드") + " · 나눔보드";
  }, [archivedView]);

  const all = boards.status === "ok" ? boards.data : [];
  const activeCount = all.filter((b) => !b.archived).length;
  const archivedCount = all.length - activeCount;
  const list = sortBoards(all.filter((b) => b.archived === archivedView && matchesBoard(b, query)));

  return (
    <div class="stack t-page">
      <div class="t-page-head">
        <h1 class="t-h1">내 보드</h1>
        <button type="button" class="btn btn-primary" onClick={() => setCreating(true)}>
          + 새 보드 만들기
        </button>
      </div>

      <div class="t-toolbar">
        <div class="t-tabs" role="group" aria-label="보드 보기">
          <Link href="/teacher" class="t-tab" aria-current={!archivedView ? "page" : undefined}>
            만든 보드{boards.status === "ok" && <span class="t-count">{activeCount}</span>}
          </Link>
          <Link href="/teacher?view=archived" class="t-tab" aria-current={archivedView ? "page" : undefined}>
            보관함{boards.status === "ok" && <span class="t-count">{archivedCount}</span>}
          </Link>
        </div>
        <div class="t-search">
          <label for="board-search" class="sr-only">
            보드 찾기
          </label>
          <input
            id="board-search"
            class="input"
            type="search"
            placeholder="제목·입장 코드·반으로 찾기"
            value={query}
            onInput={(e) => setQuery(e.currentTarget.value)}
          />
        </div>
      </div>

      {boards.status === "loading" && <Loading text="보드 목록을 불러오는 중이에요…" />}
      {boards.status === "error" && <ErrorBox error={boards.error} onRetry={reload} />}
      {boards.status === "ok" &&
        (list.length ? (
          <ul class="t-board-grid" aria-label={archivedView ? "보관한 보드" : "만든 보드"}>
            {list.map((b) => (
              <BoardCard key={b.id} board={b} onShare={() => setSharing(b)} />
            ))}
          </ul>
        ) : query.trim() ? (
          <Empty title="찾는 보드가 없어요.">
            <p class="muted">다른 낱말로 찾아보거나 {archivedView ? "만든 보드" : "보관함"}도 확인해 보세요.</p>
          </Empty>
        ) : archivedView ? (
          <Empty title="보관한 보드가 없어요.">
            <p class="muted">수업이 끝난 보드를 보관하면 학생은 들어올 수 없고, 선생님은 언제든 다시 꺼낼 수 있어요.</p>
          </Empty>
        ) : (
          <Empty title="아직 만든 보드가 없어요.">
            <p class="muted">첫 보드를 만들어 학생들과 생각을 나눠 보세요.</p>
            <button type="button" class="btn btn-primary" onClick={() => setCreating(true)}>
              + 새 보드 만들기
            </button>
          </Empty>
        ))}

      {!archivedView && <RecentPosts />}

      {creating && (
        <BoardForm
          onClose={() => setCreating(false)}
          onSaved={(b: BoardDetail) => {
            setCreating(false);
            go(`/teacher/boards/${b.id}?created=1`);
          }}
        />
      )}
      {sharing && <ShareModal board={sharing} onClose={() => setSharing(null)} />}
    </div>
  );
}

function BoardCard(props: { board: BoardSummary; onShare: () => void }) {
  const b = props.board;
  return (
    <li class={"card t-board" + (b.archived ? " is-archived" : "")}>
      <div class="t-board-top">
        <h2 class="t-board-title">
          <Link href={`/teacher/boards/${b.id}`}>{b.title}</Link>
        </h2>
        <div class="row t-gap-1">
          {b.locked && <span class="chip chip-warn">잠금</span>}
          {b.archived && <span class="chip chip-danger">보관됨</span>}
        </div>
      </div>
      <p class="t-board-code">
        <span class="label">입장 코드</span> <strong>{spacedCode(b.code)}</strong>
      </p>
      <div class="row t-gap-1">
        <span class="chip">{TYPE_LABEL[b.type]}</span>
        <span class="chip">{COLUMN_LABEL[b.columnMode]}</span>
        <span class="chip">{b.entryMode === "roster" ? (b.className ?? "반 미연결") : ENTRY_LABEL.free}</span>
      </div>
      <p class="hint t-board-meta">
        글 {b.postCount}개 · 마지막 글 {relativeTime(b.lastPostAt)}
      </p>
      <div class="row t-board-actions">
        <a class="btn btn-small btn-primary" href={`/b/${b.code}`}>
          보드 열기
        </a>
        <button type="button" class="btn btn-small" onClick={props.onShare}>
          공유·QR
        </button>
        <Link href={`/teacher/boards/${b.id}`} class="btn btn-small">
          관리
        </Link>
      </div>
    </li>
  );
}

function RecentPosts() {
  const [posts, reload] = useAsync<RecentPost[]>(() => api.recentPosts(8), []);
  return (
    <section class="stack t-section" aria-labelledby="recent-title">
      <div class="t-page-head">
        <h2 id="recent-title" class="t-h2">
          최근 올라온 글
        </h2>
        <button type="button" class="btn btn-small btn-ghost" onClick={reload}>
          새로 보기
        </button>
      </div>
      <p class="hint">모든 보드에서 학생들이 최근에 쓴 글이에요. 길게는 30초쯤 늦게 보일 수 있어요.</p>
      {posts.status === "loading" && <Loading />}
      {posts.status === "error" && <ErrorBox error={posts.error} onRetry={reload} />}
      {posts.status === "ok" &&
        (posts.data.length ? (
          <ul class="t-recent">
            {posts.data.map((p) => (
              <li key={p.boardId + p.postId} class="card t-recent-item">
                <a href={`/b/${p.boardCode}`} class="t-recent-link">
                  <span class="t-recent-board">{p.boardTitle}</span>
                  <span class="t-recent-who">
                    {p.authorNumber ? `${p.authorNumber} ` : ""}
                    {p.authorName}
                    {p.hasImage && <span class="chip t-ml">사진</span>}
                    {p.status === "pending" && <span class="chip chip-warn t-ml">승인 대기</span>}
                    {p.status === "hidden" && <span class="chip chip-danger t-ml">숨김</span>}
                  </span>
                  {p.title && <strong class="t-recent-title">{p.title}</strong>}
                  {p.excerpt && <span class="t-recent-text">{p.excerpt}</span>}
                  <span class="hint">{relativeTime(p.createdAt)}</span>
                </a>
              </li>
            ))}
          </ul>
        ) : (
          <Empty title="아직 올라온 글이 없어요." />
        ))}
    </section>
  );
}
