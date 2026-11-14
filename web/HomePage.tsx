/** 처음 화면 (/): 소개, 선생님 시작하기, 학생 입장 코드 입력. 학생도 보는 화면이라 교사 코드를 불러오지 않는다. */
import "./ui/tokens.css";
import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { MeResponse } from "../src/shared/api";
import { BOARD_CODE_LENGTH, isValidBoardCode, normalizeBoardCode } from "../src/shared/protocol";
import { fetchMe } from "./lib/api";
import { navigate } from "./lib/router";

const css = `
.h-wrap { min-height: 100dvh; display: grid; place-items: center; padding: var(--sp-4); }
.h-box { width: min(480px, 100%); display: grid; gap: var(--sp-4); }
.h-brand { margin: 0; font-size: var(--fs-2xl); font-weight: 800; color: var(--c-primary-strong); }
.h-intro { margin: 0; color: var(--c-text-2); }
.h-card { display: grid; gap: var(--sp-3); }
.h-card h2 { margin: 0; font-size: var(--fs-l); }
.h-card p { margin: 0; }
.h-code { display: flex; gap: var(--sp-2); }
.h-code .input { flex: 1; min-width: 0; font-size: var(--fs-xl); letter-spacing: .15em; text-transform: uppercase; font-weight: 700; text-align: center; }
.h-code .input::placeholder { letter-spacing: normal; font-weight: 400; font-size: var(--fs-m); text-transform: none; }
.h-setup { background: var(--c-warn-soft); border-radius: var(--r-m); padding: var(--sp-3) var(--sp-4); display: grid; gap: var(--sp-2); }
.h-setup p { margin: 0; }
`;

export function HomePage() {
  const [me, setMe] = useState<MeResponse | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    document.title = "나눔보드";
    fetchMe().then(setMe, () => setMe(null));
  }, []);

  const submit = (e: JSX.TargetedEvent<HTMLFormElement>) => {
    e.preventDefault();
    const c = normalizeBoardCode(code);
    if (!c) return setError("선생님이 알려 준 입장 코드를 입력해 주세요.");
    if (!isValidBoardCode(c)) return setError(`입장 코드는 ${BOARD_CODE_LENGTH}글자예요. 다시 확인해 주세요.`);
    navigate(`/b/${c}`);
  };

  const notReady = me && (!me.setup.googleConfigured || !me.setup.ownerClaimed);

  return (
    <main class="h-wrap">
      <style>{css}</style>
      <div class="h-box">
        <div>
          <h1 class="h-brand">나눔보드</h1>
          <p class="h-intro">
            수업 시간에 선생님과 학생이 함께 쓰는 실시간 게시판이에요. 학생이 올린 글과 사진은 바로 모두의 화면에 나타나고, 자료는 선생님의 Google 드라이브에 안전하게
            저장돼요.
          </p>
        </div>

        <section class="card h-card" aria-labelledby="h-student">
          <h2 id="h-student">학생 입장</h2>
          <form class="stack" onSubmit={submit} noValidate>
            <label for="h-code-input" class="label">
              선생님이 알려 준 입장 코드
            </label>
            <div class="h-code">
              <input
                id="h-code-input"
                class="input"
                inputMode="text"
                autoComplete="off"
                autoCapitalize="characters"
                spellcheck={false}
                maxLength={12}
                placeholder="예: K7QX2M"
                value={code}
                aria-invalid={!!error}
                aria-describedby={error ? "h-code-error" : undefined}
                onInput={(e) => {
                  setCode(e.currentTarget.value.toUpperCase());
                  setError(null);
                }}
              />
              <button type="submit" class="btn btn-primary">
                입장
              </button>
            </div>
            {error && (
              <p id="h-code-error" class="error-text" role="alert">
                {error}
              </p>
            )}
          </form>
        </section>

        <section class="card h-card" aria-labelledby="h-teacher">
          <h2 id="h-teacher">선생님</h2>
          {notReady ? (
            <div class="h-setup">
              <p>
                {!me.setup.googleConfigured
                  ? "아직 설치가 끝나지 않았어요. Google 로그인 설정을 먼저 해 주세요."
                  : "설치는 끝났어요. 처음 로그인하는 Google 계정이 이 나눔보드의 주인이 돼요."}
              </p>
              {!me.setup.googleConfigured ? (
                <a class="btn btn-primary" href="/setup">
                  설치 안내 보기
                </a>
              ) : (
                <a class="btn btn-primary" href="/teacher">
                  선생님 시작하기
                </a>
              )}
            </div>
          ) : (
            <>
              <p class="muted">보드를 만들고, 반 명단과 QR 코드를 준비해요.</p>
              <a class="btn btn-primary" href="/teacher">
                선생님 시작하기
              </a>
            </>
          )}
        </section>
      </div>
    </main>
  );
}
