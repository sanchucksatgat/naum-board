import { useEffect, useState } from "preact/hooks";
import { isValidBoardCode, normalizeBoardCode, type BoardPublicInfo } from "../../src/shared/protocol";
import { fetchMe } from "../lib/api";
import { navigate } from "../lib/router";
import { setUploadAuthHeader } from "../lib/upload";
import type { ClosedReason } from "../lib/realtime";
import { BoardScreen } from "../board/BoardScreen";
import { UiHost } from "../ui/UiHost";
import { PageSpinner } from "../ui/Spinner";
import { ApiError, studentApi } from "./api";
import { Entry } from "./Entry";
import { getStudentToken, setStudentToken } from "./storage";
import "./entry.css";

type Phase =
  | { k: "loading" }
  | { k: "notfound"; deleted?: boolean }
  | { k: "archived" }
  | { k: "error"; message: string }
  | { k: "entry"; info: BoardPublicInfo; message?: string }
  | { k: "board"; role: "teacher" | "student"; info: BoardPublicInfo | null };

/**
 * /b/:code — 학생 입장과 보드 화면 (교사도 같은 주소로 들어와 보드 안에서 관리한다).
 * 교사 로그인(/api/me)이 되어 있으면 교사 쿠키로 접속한다. `?as=student` 면 교사여도 학생 입장 화면.
 */
export function StudentBoardPage(props: { params: Record<string, string> }) {
  const code = normalizeBoardCode(props.params.code ?? "");
  const [phase, setPhase] = useState<Phase>({ k: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    setUploadAuthHeader((): Record<string, string> => {
      const t = getStudentToken(code);
      return t ? { authorization: "Bearer " + t } : {};
    });
  }, [code]);

  useEffect(() => {
    if (!isValidBoardCode(code)) {
      setPhase({ k: "notfound" });
      return;
    }
    let alive = true;
    const asStudent = new URLSearchParams(location.search).get("as") === "student";
    void (async () => {
      const [info, me] = await Promise.all([
        studentApi.info(code).then(
          (v) => ({ ok: true as const, v }),
          (e: unknown) => ({ ok: false as const, e }),
        ),
        asStudent ? Promise.resolve(null) : fetchMe().catch(() => null),
      ]);
      if (!alive) return;
      if (me?.authenticated) {
        // 교사: 학생 토큰은 쓰지 않는다 (같은 기기에서 시험해 본 학생 토큰이 있어도)
        setUploadAuthHeader(() => ({}));
        setPhase({ k: "board", role: "teacher", info: info.ok ? info.v : null });
        return;
      }
      if (!info.ok) {
        const e = info.e;
        if (e instanceof ApiError && e.status === 404) setPhase({ k: "notfound" });
        else setPhase({ k: "error", message: e instanceof ApiError ? e.message : "보드를 불러오지 못했어요." });
        return;
      }
      if (info.v.archived) {
        setPhase({ k: "archived" });
        return;
      }
      if (getStudentToken(code)) setPhase({ k: "board", role: "student", info: info.v });
      else setPhase({ k: "entry", info: info.v });
    })();
    return () => {
      alive = false;
    };
  }, [code, attempt]);

  useEffect(() => {
    if (phase.k === "board" && phase.info) document.title = `${phase.info.title} - 나눔보드`;
    else if (phase.k === "entry") document.title = `${phase.info.title} - 나눔보드`;
  }, [phase]);

  const onClosed = (reason: ClosedReason) => {
    if (reason === "archived") return setPhase({ k: "archived" });
    if (reason === "deleted" || reason === "not_found") return setPhase({ k: "notfound", deleted: reason === "deleted" });
    if (phase.k === "board" && phase.role === "student") {
      setStudentToken(code, null);
      void studentApi.info(code).then(
        (info) => setPhase({ k: "entry", info, message: "다시 들어와 주세요. (선생님이 PIN이나 명단을 바꿨을 수 있어요)" }),
        () => setPhase({ k: "notfound" }),
      );
      return;
    }
    setPhase({ k: "error", message: "선생님 로그인이 풀렸어요. 다시 로그인해 주세요." });
  };

  let body;
  switch (phase.k) {
    case "loading":
      body = <PageSpinner label="보드를 여는 중이에요" />;
      break;
    case "notfound":
      body = <NotFound deleted={!!phase.deleted} code={code} />;
      break;
    case "archived":
      body = (
        <Notice icon="📦" title="보관된 보드예요" text="이 보드는 선생님이 보관함에 넣어서 지금은 들어갈 수 없어요. 궁금하면 선생님께 여쭤 보세요." />
      );
      break;
    case "error":
      body = (
        <Notice icon="😢" title="보드를 열지 못했어요" text={phase.message}>
          <div class="row" style={{ justifyContent: "center" }}>
            <button class="btn btn-primary" onClick={() => setAttempt((n) => n + 1)}>
              다시 해 보기
            </button>
            {phase.message.includes("로그인") ? (
              <a class="btn" href="/auth/google">
                다시 로그인
              </a>
            ) : null}
          </div>
        </Notice>
      );
      break;
    case "entry":
      body = (
        <Entry
          code={code}
          info={phase.info}
          message={phase.message}
          onEntered={(token) => {
            setStudentToken(code, token);
            setPhase({ k: "board", role: "student", info: phase.info });
          }}
        />
      );
      break;
    case "board":
      body = (
        <BoardScreen
          key={phase.role}
          code={code}
          role={phase.role}
          getToken={() => (phase.role === "student" ? getStudentToken(code) : null)}
          setToken={(t) => setStudentToken(code, t)}
          onClosed={onClosed}
          onLeave={() => {
            setStudentToken(code, null);
            void studentApi.info(code).then(
              (info) => setPhase({ k: "entry", info }),
              () => setAttempt((n) => n + 1),
            );
          }}
        />
      );
      break;
  }
  return (
    <>
      {body}
      <UiHost />
    </>
  );
}

function Notice(props: { icon: string; title: string; text: string; children?: preact.ComponentChildren }) {
  return (
    <main class="entry">
      <div class="entry-card card stack" style={{ textAlign: "center" }}>
        <div class="entry-big-icon" aria-hidden="true">
          {props.icon}
        </div>
        <h1 class="entry-title">{props.title}</h1>
        <p class="muted">{props.text}</p>
        {props.children}
      </div>
    </main>
  );
}

function NotFound(props: { deleted: boolean; code: string }) {
  const [v, setV] = useState("");
  const [err, setErr] = useState<string | null>(null);
  return (
    <Notice
      icon="🔍"
      title={props.deleted ? "없어진 보드예요" : "보드를 찾을 수 없어요"}
      text={props.deleted ? "선생님이 이 보드를 지웠어요." : "입장코드를 다시 확인해 주세요. 선생님이 알려 준 숫자 4자리를 써요."}
    >
      <form
        class="row entry-code-form"
        onSubmit={(e) => {
          e.preventDefault();
          const c = normalizeBoardCode(v);
          if (!isValidBoardCode(c)) return setErr("입장코드는 숫자 4자리예요.");
          navigate("/b/" + c);
        }}
      >
        <label class="sr-only" for="code-again">
          입장코드
        </label>
        <input
          id="code-again"
          class="input entry-input"
          inputMode="numeric"
          autoCapitalize="characters"
          autoComplete="off"
          maxLength={8}
          placeholder="예: 4821"
          value={v}
          onInput={(e) => setV((e.currentTarget as HTMLInputElement).value.toUpperCase())}
        />
        <button class="btn btn-primary" type="submit">
          들어가기
        </button>
      </form>
      {err ? <p class="error-text">{err}</p> : null}
    </Notice>
  );
}
