/** 학생 입장 공유: 링크·QR (브라우저에서 생성), 프로젝터용 입장 안내 화면 */
import { useEffect, useMemo, useState } from "preact/hooks";
import type { BoardSummary } from "../../src/shared/protocol";
import { api } from "./api";
import { spacedCode, studentUrl } from "./format";
import { go } from "./nav";
import { qrPath } from "./qr";
import { ErrorBox, Loading, Modal, copyText, toast, useAsync } from "./ui";

export function QrCode(props: { text: string; label: string; class?: string }) {
  const qr = useMemo(() => {
    try {
      return qrPath(props.text);
    } catch {
      return null;
    }
  }, [props.text]);
  if (!qr) return <p class="error-text">QR 코드를 만들지 못했어요. 아래 주소를 알려 주세요.</p>;
  return (
    <svg
      class={"t-qr " + (props.class ?? "")}
      viewBox={`0 0 ${qr.size} ${qr.size}`}
      role="img"
      aria-label={props.label}
      shape-rendering="crispEdges"
      data-qr-text={props.text}
    >
      <rect width={qr.size} height={qr.size} fill="#fff" />
      <path d={qr.d} fill="#000" />
    </svg>
  );
}

type ShareBoard = Pick<BoardSummary, "id" | "code" | "title" | "archived" | "entryMode">;

export function ShareModal(props: { board: ShareBoard; created?: boolean; onClose: () => void }) {
  const { board } = props;
  const url = studentUrl(location.origin, board.code);
  const copy = async () => {
    const ok = await copyText(url);
    toast(ok ? "학생 입장 주소를 복사했어요." : "복사하지 못했어요. 주소 칸을 길게 눌러 복사해 주세요.", ok ? "info" : "error");
  };
  return (
    <Modal title={props.created ? "보드가 준비됐어요!" : "학생 입장 안내"} onClose={props.onClose} wide>
      <div class="t-share">
        <div class="t-share-qr">
          <QrCode text={url} label={`${board.title} 학생 입장 QR 코드`} />
        </div>
        <div class="stack">
          <p class="muted t-share-title">{board.title}</p>
          {board.archived && <p class="t-warnbox">보관된 보드예요. 보관을 풀어야 학생이 들어올 수 있어요.</p>}
          <div>
            <p class="label">입장 코드</p>
            <p class="t-code-big" aria-label={`입장 코드 ${board.code.split("").join(" ")}`}>
              {spacedCode(board.code)}
            </p>
          </div>
          <div class="field">
            <label for="share-url">학생 입장 주소</label>
            <div class="t-inline">
              <input id="share-url" class="input" readOnly value={url} onFocus={(e) => e.currentTarget.select()} />
              <button type="button" class="btn" onClick={copy}>
                복사
              </button>
            </div>
          </div>
          <p class="hint">
            {board.entryMode === "roster" ? "학생은 QR을 찍거나 주소로 들어와 학번과 PIN을 입력해요." : "학생은 QR을 찍거나 주소로 들어와 닉네임만 적으면 돼요."}
          </p>
          <div class="row">
            <button type="button" class="btn btn-primary" onClick={() => go(`/teacher/boards/${board.id}/projector`)}>
              프로젝터로 크게 보기
            </button>
            <a class="btn" href={`/b/${board.code}`}>
              보드 열기
            </a>
          </div>
        </div>
      </div>
    </Modal>
  );
}

/** 프로젝터·인쇄용 입장 안내 (화면 전체) */
export function Projector(props: { boardId: string }) {
  const [board, reload] = useAsync(() => api.board(props.boardId), [props.boardId]);
  const [full, setFull] = useState(false);
  const close = () => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    if (history.length > 1) history.back();
    else go(`/teacher/boards/${props.boardId}`);
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !document.fullscreenElement) close();
    };
    const onFs = () => setFull(!!document.fullscreenElement);
    addEventListener("keydown", onKey);
    document.addEventListener("fullscreenchange", onFs);
    return () => {
      removeEventListener("keydown", onKey);
      document.removeEventListener("fullscreenchange", onFs);
    };
  }, []);
  const toggleFull = () => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    else void document.documentElement.requestFullscreen?.().catch(() => toast("이 브라우저는 전체 화면을 지원하지 않아요.", "error"));
  };
  if (board.status === "loading") return <Loading />;
  if (board.status === "error")
    return (
      <main class="t-center">
        <ErrorBox error={board.error} onRetry={reload} />
      </main>
    );
  const b = board.data;
  const url = studentUrl(location.origin, b.code);
  const shortUrl = url.replace(/^https?:\/\//, "");
  return (
    <main class="t-projector">
      <div class="t-projector-bar no-print">
        <button type="button" class="btn btn-small" onClick={toggleFull}>
          {full ? "전체 화면 끝내기" : "전체 화면"}
        </button>
        <button type="button" class="btn btn-small" onClick={() => window.print()}>
          인쇄
        </button>
        <button type="button" class="btn btn-small" onClick={close} autoFocus>
          닫기
        </button>
      </div>
      <h1 class="t-projector-title">{b.title}</h1>
      <div class="t-projector-body">
        <QrCode text={url} label={`${b.title} 학생 입장 QR 코드`} class="t-projector-qr" />
        <div class="t-projector-info">
          <p class="t-projector-step">휴대폰 카메라로 QR 코드를 찍거나</p>
          <p class="t-projector-url">{shortUrl.replace(/\/b\/.*$/, "")}</p>
          <p class="t-projector-step">에 들어가서 입장 코드를 입력하세요</p>
          <p class="t-projector-code">{spacedCode(b.code)}</p>
          <p class="t-projector-step">{b.entryMode === "roster" ? "그다음 학번과 PIN을 입력해요." : "그다음 닉네임을 적어요."}</p>
        </div>
      </div>
    </main>
  );
}
