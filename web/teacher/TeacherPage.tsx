/** 교사 화면 진입점 (/teacher/*). 로그인 상태 확인 → 로그인 화면 또는 관리 화면. */
import "../ui/tokens.css";
import "./teacher.css";
import { useEffect } from "preact/hooks";
import type { MeResponse } from "../../src/shared/api";
import { fetchMe } from "../lib/api";
import { AUTH_LOST_EVENT, api } from "./api";
import { Link, go, useLoc, type Loc } from "./nav";
import { ErrorBox, Loading, Toasts, toast, useAction, useAsync } from "./ui";
import { Dashboard } from "./Dashboard";
import { BoardManage } from "./BoardManage";
import { Projector } from "./Share";
import { ClassList, ClassDetail } from "./Classes";
import { PinSlips } from "./PinSlips";
import { PortfolioHome, StudentPortfolio } from "./Portfolio";

export function TeacherPage() {
  const [me, reloadMe] = useAsync(fetchMe, []);
  const loc = useLoc();
  useEffect(() => {
    addEventListener(AUTH_LOST_EVENT, reloadMe);
    return () => removeEventListener(AUTH_LOST_EVENT, reloadMe);
  }, [reloadMe]);
  useEffect(() => {
    document.title = "선생님 화면 · 나눔보드";
  }, []);

  if (me.status === "loading") return <Loading text="로그인 상태를 확인하고 있어요…" />;
  if (me.status === "error")
    return (
      <main class="t-center">
        <ErrorBox error={me.error} onRetry={reloadMe} />
      </main>
    );
  const m = me.data;
  if (!m.authenticated) return <LoginScreen me={m} />;
  return <Shell me={m} loc={loc} onRecheck={reloadMe} />;
}

// ───────────── 로그인 전 ─────────────

function LoginScreen(props: { me: MeResponse }) {
  const { setup } = props.me;
  const needsSetup = !setup.googleConfigured;
  return (
    <main class="t-center">
      <div class="card t-login stack">
        <p class="t-brand-mark" aria-hidden="true">
          나눔보드
        </p>
        <h1 class="t-h1">선생님 화면</h1>
        {needsSetup ? (
          <>
            <p>아직 설치가 끝나지 않았어요. Google 로그인 설정을 먼저 해 주세요.</p>
            <a class="btn btn-primary" href="/setup">
              설치 안내 보기
            </a>
          </>
        ) : (
          <>
            <p>
              {setup.ownerClaimed
                ? "처음 연결한 Google 계정으로 로그인해 주세요."
                : "처음 로그인하는 Google 계정이 이 나눔보드의 주인(선생님)이 돼요."}
            </p>
            <a class="btn btn-primary t-google-btn" href="/auth/google">
              Google 계정으로 시작하기
            </a>
            <div class="t-note">
              <p class="t-note-title">Google 드라이브 권한에 대해</p>
              <ul>
                <li>
                  나눔보드는 드라이브에서 <strong>이 앱이 만든 파일만</strong> 보고 고칠 수 있어요. 선생님의 다른 파일은 볼 수 없어요.
                </li>
                <li>학생이 올린 사진·파일과 글 백업은 선생님 드라이브의 ‘나눔보드’ 폴더에 저장돼요.</li>
                <li>Google 화면에서 드라이브 관련 체크 칸이 보이면 꼭 켜 주세요.</li>
              </ul>
            </div>
          </>
        )}
        <p class="hint">
          <a href="/">처음 화면으로</a>
        </p>
      </div>
    </main>
  );
}

// ───────────── 로그인 후 ─────────────

type Section = "boards" | "classes" | "portfolio";

function sectionOf(loc: Loc): Section {
  const p = loc.parts[0];
  if (p === "classes") return "classes";
  if (p === "portfolio" || p === "students") return "portfolio";
  return "boards";
}

function Shell(props: { me: MeResponse; loc: Loc; onRecheck: () => void }) {
  const { loc, me } = props;
  const section = sectionOf(loc);
  const [busy, run] = useAction();
  const logout = () =>
    run(async () => {
      await api.logout();
      toast("로그아웃했어요.");
      go("/");
    });
  const [a, b, c] = loc.parts;

  // 프로젝터 입장 안내는 화면 전체를 쓴다
  if (a === "boards" && b && c === "projector") return <Projector boardId={b} />;

  let page;
  if (a === "boards" && b) page = <BoardManage id={b} created={loc.query.get("created") === "1"} />;
  else if (a === "classes" && b && c === "pins") page = <PinSlips classId={b} boardId={loc.query.get("board")} />;
  else if (a === "classes" && b) page = <ClassDetail id={b} />;
  else if (a === "classes") page = <ClassList />;
  else if (a === "students" && b) page = <StudentPortfolio id={b} />;
  else if (a === "portfolio") page = <PortfolioHome classId={loc.query.get("class")} />;
  else page = <Dashboard view={loc.query.get("view") === "archived" ? "archived" : "active"} />;

  return (
    <div class="t-app">
      <a class="t-skip" href="#t-main">
        본문으로 건너뛰기
      </a>
      <header class="t-header no-print">
        <div class="t-header-in">
          <Link href="/teacher" class="t-brand">
            나눔보드
          </Link>
          <nav class="t-nav" aria-label="선생님 메뉴">
            <Link href="/teacher" class="t-nav-item" aria-current={section === "boards" ? "page" : undefined}>
              보드
            </Link>
            <Link href="/teacher/classes" class="t-nav-item" aria-current={section === "classes" ? "page" : undefined}>
              반·명단
            </Link>
            <Link href="/teacher/portfolio" class="t-nav-item" aria-current={section === "portfolio" ? "page" : undefined}>
              포트폴리오
            </Link>
          </nav>
          <div class="t-account">
            <span class="t-email" title={me.teacher?.email}>
              {me.teacher?.email}
            </span>
            <button type="button" class="btn btn-small btn-ghost" onClick={logout} disabled={busy}>
              로그아웃
            </button>
          </div>
        </div>
      </header>
      <DriveBanner me={me} onRecheck={props.onRecheck} />
      <main id="t-main" class="t-main" tabIndex={-1}>
        {page}
      </main>
      <Toasts />
    </div>
  );
}

function DriveBanner(props: { me: MeResponse; onRecheck: () => void }) {
  const status = props.me.drive?.status ?? "ok";
  if (status === "ok") return null;
  const text =
    status === "missing_scope"
      ? "로그인할 때 Google 드라이브 권한이 빠졌어요. 학생이 사진·파일을 올리거나 백업하려면 드라이브 권한이 필요해요."
      : status === "reconnect_required"
        ? "Google 드라이브 연결이 끊겼어요. 사진 올리기·백업·시트 내보내기가 멈춰 있어요."
        : "지금 Google 드라이브 상태를 확인하지 못했어요. 잠시 뒤 다시 확인해 주세요.";
  return (
    <div class={"t-banner no-print " + (status === "unavailable" ? "is-warn" : "is-danger")} role="alert">
      <p>{text}</p>
      {status === "unavailable" ? (
        <button type="button" class="btn btn-small" onClick={props.onRecheck}>
          다시 확인
        </button>
      ) : (
        <a class="btn btn-small btn-primary" href="/auth/google">
          {status === "missing_scope" ? "드라이브 권한 허용하기" : "Google 드라이브 다시 연결"}
        </a>
      )}
    </div>
  );
}

