/** 보드 한 개 관리: 설정 요약·바꾸기, 이름, 공유, 드라이브(폴더·백업·시트), 명단, 보관·삭제 */
import { useEffect, useState } from "preact/hooks";
import type { BoardDetail } from "../../src/shared/protocol";
import type { BoardDriveResponse } from "../../src/shared/files";
import { api, errorMessage } from "./api";
import { BoardForm, RenameBoard } from "./BoardForm";
import { COLUMN_LABEL, TYPE_LABEL, entryText, backupText, formatDateTime, relativeTime, spacedCode } from "./format";
import { Link, go } from "./nav";
import { ShareModal } from "./Share";
import { ErrorBox, Loading, TypeToConfirm, toast, useAction, useAsync } from "./ui";

type Dialog = null | "settings" | "rename" | "share" | "delete";

export function BoardManage(props: { id: string; created?: boolean }) {
  const [board, reload, mutate] = useAsync(() => api.board(props.id), [props.id]);
  const [dialog, setDialog] = useState<Dialog>(props.created ? "share" : null);
  const [busy, run] = useAction();

  useEffect(() => {
    if (board.status === "ok") document.title = `${board.data.title} · 나눔보드`;
  }, [board]);

  if (board.status === "loading") return <Loading text="보드 정보를 불러오는 중이에요…" />;
  if (board.status === "error")
    return (
      <div class="stack t-page">
        <BackLink />
        <ErrorBox error={board.error} onRetry={reload} />
      </div>
    );
  const b = board.data;
  const s = b.settings;
  const saved = (next: BoardDetail, msg: string) => {
    mutate(() => next);
    setDialog(null);
    toast(msg);
  };
  const closeShare = () => {
    setDialog(null);
    if (props.created) go(`/teacher/boards/${b.id}`, { replace: true });
  };

  const toggleArchive = () =>
    run(async () => {
      const next = await api.archive(b.id, !b.archived);
      mutate(() => next);
      toast(next.archived ? "보관함으로 옮겼어요. 학생은 이제 들어올 수 없어요." : "보관을 풀었어요. 학생이 다시 들어올 수 있어요.");
    });

  return (
    <div class="stack t-page">
      <BackLink archived={b.archived} />
      <div class="t-page-head">
        <div class="t-minw0">
          <h1 class="t-h1 t-break">{b.title}</h1>
          <p class="row t-gap-1">
            <span class="chip chip-primary">입장 코드 {spacedCode(b.code)}</span>
            {s.locked && <span class="chip chip-warn">잠금</span>}
            {b.archived && <span class="chip chip-danger">보관됨</span>}
          </p>
        </div>
        <button type="button" class="btn btn-small" onClick={() => setDialog("rename")}>
          이름 바꾸기
        </button>
      </div>

      {b.archived && <p class="t-warnbox">보관된 보드예요. 학생은 들어올 수 없고, 선생님은 읽기만 할 수 있어요.</p>}

      <div class="t-actions-bar">
        <a class="btn btn-primary" href={`/b/${b.code}`}>
          보드 열기
        </a>
        <button type="button" class="btn" onClick={() => setDialog("share")}>
          공유·QR
        </button>
        <Link href={`/teacher/boards/${b.id}/projector`} class="btn">
          입장 안내 화면
        </Link>
      </div>

      <div class="t-two">
        <section class="card stack" aria-labelledby="sec-settings">
          <div class="t-page-head">
            <h2 id="sec-settings" class="t-h2">
              설정
            </h2>
            <button type="button" class="btn btn-small" onClick={() => setDialog("settings")}>
              설정 바꾸기
            </button>
          </div>
          <dl class="t-dl">
            <dt>보드 유형</dt>
            <dd>{TYPE_LABEL[s.type]}</dd>
            <dt>열 구성</dt>
            <dd>{COLUMN_LABEL[s.columnMode]}</dd>
            <dt>입장 방식</dt>
            <dd>{entryText(s)}</dd>
            {s.entryMode === "roster" && (
              <>
                <dt>반</dt>
                <dd>{b.classId ? <Link href={`/teacher/classes/${b.classId}`}>{b.className ?? "반 보기"}</Link> : <span class="t-text-warn">아직 연결 안 됨</span>}</dd>
              </>
            )}
            <dt>승인 후 게시</dt>
            <dd>{s.moderation ? "켜짐" : "꺼짐"}</dd>
            <dt>익명 모드</dt>
            <dd>{s.anonymous ? "켜짐" : "꺼짐"}</dd>
            <dt>좋아요 · 댓글</dt>
            <dd>
              {s.allowLikes ? "좋아요 허용" : "좋아요 끔"} · {s.allowComments ? "댓글 허용" : "댓글 끔"}
            </dd>
            <dt>잠금</dt>
            <dd>{s.locked ? "잠김 (학생은 읽기만)" : "열림"}</dd>
            <dt>글</dt>
            <dd>
              {b.postCount}개 · 마지막 글 {relativeTime(b.lastPostAt)}
            </dd>
            <dt>만든 날</dt>
            <dd>{formatDateTime(b.createdAt)}</dd>
          </dl>
          {s.entryMode === "roster" && b.classId && (
            <div class="row">
              {s.requirePin && (
                <Link href={`/teacher/classes/${b.classId}/pins?board=${b.id}`} class="btn btn-small">
                  PIN 쪽지 인쇄
                </Link>
              )}
              <Link href={`/teacher/classes/${b.classId}`} class="btn btn-small">
                명단 관리
              </Link>
            </div>
          )}
        </section>

        <DriveSection board={b} />
      </div>

      <section class="card stack t-danger-zone" aria-labelledby="sec-danger">
        <h2 id="sec-danger" class="t-h2">
          보관 · 삭제
        </h2>
        <div class="t-danger-row">
          <div>
            <p class="t-strong">{b.archived ? "보관 풀기" : "보관함으로 옮기기"}</p>
            <p class="hint">{b.archived ? "학생이 다시 들어와 글을 쓸 수 있어요." : "수업이 끝난 보드를 정리해요. 글은 그대로 남고 언제든 다시 꺼낼 수 있어요."}</p>
          </div>
          <button type="button" class="btn" onClick={toggleArchive} disabled={busy}>
            {busy ? "바꾸는 중…" : b.archived ? "보관 풀기" : "보관하기"}
          </button>
        </div>
        <div class="t-danger-row">
          <div>
            <p class="t-strong">보드 지우기</p>
            <p class="hint">보드와 글이 나눔보드에서 지워져요. 드라이브에 저장된 사진·백업 파일은 남아요.</p>
          </div>
          <button type="button" class="btn btn-danger" onClick={() => setDialog("delete")}>
            지우기…
          </button>
        </div>
      </section>

      {dialog === "settings" && <BoardForm board={b} onClose={() => setDialog(null)} onSaved={(n) => saved(n, "설정을 저장했어요.")} />}
      {dialog === "rename" && <RenameBoard board={b} onClose={() => setDialog(null)} onSaved={(n) => saved(n, "보드 이름을 바꿨어요.")} />}
      {dialog === "share" && <ShareModal board={b} created={props.created} onClose={closeShare} />}
      {dialog === "delete" && (
        <TypeToConfirm
          title="보드 지우기"
          expected={b.title}
          actionLabel="영구히 지우기"
          description={
            <>
              <p>
                <strong>{b.title}</strong> 보드와 학생 글 {b.postCount}개가 지워지고 되돌릴 수 없어요.
              </p>
              <p>드라이브의 사진·백업 파일은 남아요. 잠시 쉬게 하려면 지우지 말고 ‘보관하기’를 써 주세요.</p>
            </>
          }
          onClose={() => setDialog(null)}
          onConfirm={async () => {
            await api.deleteBoard(b.id);
            toast("보드를 지웠어요.");
            go("/teacher");
          }}
        />
      )}
    </div>
  );
}

function BackLink(props: { archived?: boolean }) {
  return (
    <p class="no-print">
      <Link href={props.archived ? "/teacher?view=archived" : "/teacher"} class="t-back">
        ← {props.archived ? "보관함" : "내 보드"}
      </Link>
    </p>
  );
}

function DriveSection(props: { board: BoardDetail }) {
  const b = props.board;
  const [drive, reload] = useAsync<BoardDriveResponse>(() => api.drive(b.code), [b.code]);
  const [exporting, setExporting] = useState(false);
  const [sheetUrl, setSheetUrl] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const backup = backupText(b.backup);

  const exportSheet = async () => {
    // 팝업 차단을 피하려고 누른 순간 빈 창을 먼저 연다
    const win = window.open("", "_blank");
    setExporting(true);
    setExportError(null);
    try {
      const { url } = await api.exportSheet(b.code);
      setSheetUrl(url);
      if (win) win.location.href = url;
      toast("시트로 내보냈어요.");
    } catch (e) {
      win?.close();
      setExportError(errorMessage(e));
    } finally {
      setExporting(false);
    }
  };

  return (
    <section class="card stack" aria-labelledby="sec-drive">
      <h2 id="sec-drive" class="t-h2">
        Google 드라이브
      </h2>
      <div>
        <p class="label">백업</p>
        <p class={"t-tone-" + backup.tone}>{backup.text}</p>
        {b.backup?.lastErrorCode === "api_disabled" && (
          <p>
            <a href="/setup#help-api" target="_blank" rel="noopener">
              Google Drive API 켜는 법 보기
            </a>
          </p>
        )}
      </div>
      <div class="stack t-gap-2">
        {drive.status === "loading" && <p class="hint">드라이브 폴더를 확인하는 중이에요…</p>}
        {drive.status === "error" && <ErrorBox error={drive.error} onRetry={reload} />}
        {drive.status === "ok" &&
          (drive.data.folderUrl ? (
            <a class="btn" href={drive.data.folderUrl} target="_blank" rel="noopener noreferrer">
              드라이브 폴더 열기
            </a>
          ) : (
            <p class="hint">아직 드라이브 폴더가 없어요. 첫 사진이나 글 백업 때 자동으로 만들어져요.</p>
          ))}
        <button type="button" class="btn" onClick={exportSheet} disabled={exporting}>
          {exporting ? "시트로 내보내는 중…" : "구글 시트로 내보내기"}
        </button>
        <p class="hint">모든 글을 한 장의 구글 시트로 만들어 드라이브 폴더에 저장해요.</p>
        {sheetUrl && (
          <p>
            <a href={sheetUrl} target="_blank" rel="noopener noreferrer">
              만든 시트 열기
            </a>
          </p>
        )}
        {exportError && (
          <p class="error-text" role="alert">
            {exportError}
          </p>
        )}
      </div>
    </section>
  );
}
