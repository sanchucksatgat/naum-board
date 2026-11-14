import "../ui/tokens.css";
import "./setup.css";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { fetchMe } from "../lib/api";
import { HelpIndex, type HelpCtx } from "./help";
import { CostSection, PrivacySection, UpdateSection } from "./sections";
import { clearState, EMPTY_STATE, hasSavedState, useSetupState } from "./state";
import { STEPS, type Mode, type StepProps } from "./steps";
import { checkInstanceUrl, derivedFromOrigin } from "./validate";

const INSTANCE_DONE = ["github", "cloudflare", "deploy", "address"];
const idx = (id: string) => Math.max(0, STEPS.findIndex((s) => s.id === id));

/**
 * 설치 안내.
 * - 설치 전(공개 안내 페이지, standalone=true 또는 /api/me 가 없는 곳): 처음부터 끝까지 안내.
 * - 설치된 나눔보드의 /setup: /api/me 로 상태를 읽어 이어 할 단계를 고르고, 주소를 자동으로 채우고, 마지막에 실제 점검.
 */
export function SetupPage(props: { params?: Record<string, string>; standalone?: boolean }) {
  const [state, update, setState] = useSetupState();
  const [mode, setMode] = useState<Mode | "detecting">(props.standalone ? "guide" : "detecting");
  const headingRef = useRef<HTMLHeadingElement>(null);
  const firstRender = useRef(true);
  const [blockMsg, setBlockMsg] = useState<string | null>(null);

  useEffect(() => {
    document.title = "나눔보드 설치 안내";
    if (props.standalone) return;
    let alive = true;
    const hadSaved = hasSavedState();
    fetchMe()
      .then((me) => {
        if (!alive) return;
        setMode("instance");
        // 설치된 곳에서 열었으면 주소·설치 단계는 이미 끝난 것
        const auto = location.hash === "#check" || me.setup.ownerClaimed ? "check" : me.setup.googleConfigured ? "login" : "gproject";
        setState((s) => {
          const done = { ...s.done };
          for (const id of INSTANCE_DONE) done[id] = true;
          // 설치된 곳의 상태가 증명하는 단계는 모두 끝난 것 (예: 주인이 있으면 Google 설정·첫 로그인까지 끝남).
          // 이렇게 해야 마지막 단계에서 진행 막대·남은 시간이 "15/15 단계"와 맞는다.
          const reached = me.setup.ownerClaimed ? idx("check") : me.setup.googleConfigured ? idx("login") : idx("gproject");
          for (const st of STEPS.slice(0, reached)) done[st.id] = true;
          const step = location.hash === "#check" || !hadSaved || idx(auto) > idx(s.step) ? auto : s.step;
          return { ...s, done, instanceUrl: location.origin, step };
        });
      })
      .catch(() => alive && setMode("guide"));
    return () => {
      alive = false;
    };
  }, []);

  // 같은 페이지 안에서 #check 로 오면 점검 단계로
  useEffect(() => {
    const onHash = () => {
      if (location.hash === "#check") update({ step: "check" });
    };
    addEventListener("hashchange", onHash);
    return () => removeEventListener("hashchange", onHash);
  }, []);

  // 막혔던 값이 채워지면 "먼저 …해 주세요" 문구를 지운다
  useEffect(() => setBlockMsg(null), [state.instanceUrl, state.clientId]);

  const origin = mode === "instance" ? location.origin : state.instanceUrl;
  const derived = useMemo(() => {
    if (!origin) return null;
    const c = checkInstanceUrl(origin);
    return c.ok ? derivedFromOrigin(c.value) : null;
  }, [origin]);

  const current = STEPS[idx(state.step)]!;
  const i = idx(current.id);

  const goStep = (id: string) => {
    setBlockMsg(null);
    update({ step: id });
    if (location.hash.startsWith("#help-")) history.replaceState(null, "", location.pathname + location.search);
  };
  const ctx: HelpCtx = { redirectUri: derived?.redirectUri, origin: derived?.origin, goStep };
  const stepProps: StepProps = { state, update, mode: mode === "instance" ? "instance" : "guide", derived, ctx };

  // 단계가 바뀌면 제목으로 초점·스크롤 (처음 열 때는 제외)
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    headingRef.current?.focus({ preventScroll: true });
    headingRef.current?.closest(".su-wizard")?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [state.step]);

  const next = () => {
    const msg = current.blocker?.(stepProps) ?? null;
    if (msg) {
      setBlockMsg(msg);
      return;
    }
    update((s) => ({ done: { ...s.done, [current.id]: true }, step: STEPS[Math.min(i + 1, STEPS.length - 1)]!.id }));
    setBlockMsg(null);
  };
  const prev = () => goStep(STEPS[Math.max(i - 1, 0)]!.id);

  const doneCount = STEPS.filter((s) => state.done[s.id]).length;
  const remaining = STEPS.filter((s) => !state.done[s.id]).reduce((a, s) => a + s.minutes, 0);
  const pct = Math.round((doneCount / STEPS.length) * 100);
  const groups = [...new Set(STEPS.map((s) => s.group))];

  return (
    <div class="su-page">
      <header class="su-header">
        <div class="su-brand">나눔보드</div>
        <h1>설치 안내</h1>
        <p class="muted">
          수업용 실시간 게시판 ‘나눔보드’를 선생님 계정에 설치해요. 한 단계에 한 가지씩만 하면 돼요.
        </p>
        {mode === "instance" && <span class="chip chip-primary">내 나눔보드({location.host})에서 보는 중</span>}
        {mode === "detecting" && <span class="chip">상태 확인 중…</span>}
      </header>

      <section class="su-wizard card" aria-labelledby="su-step-title">
        <div class="su-progress">
          <div class="su-progress-text">
            <span>
              <strong>
                {i + 1}/{STEPS.length}
              </strong>{" "}
              단계 · {current.group}
            </span>
            <span class="muted">{doneCount === STEPS.length ? "모두 끝났어요" : remaining > 0 ? `남은 시간 약 ${remaining}분` : "거의 다 왔어요"}</span>
          </div>
          <div class="su-bar" role="progressbar" aria-label="설치 진행" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
            <div class="su-bar-fill" style={{ width: `${pct}%` }} />
          </div>
          <details class="su-toc">
            <summary>전체 단계 보기 ({doneCount}개 완료)</summary>
            <div class="su-toc-groups">
              {groups.map((g) => (
                <div key={g} class="su-toc-group">
                  <div class="su-toc-gname">{g}</div>
                  <ol>
                    {STEPS.filter((s) => s.group === g).map((s) => (
                      <li key={s.id}>
                        <button
                          type="button"
                          class={`su-toc-item${s.id === current.id ? " su-toc-current" : ""}`}
                          aria-current={s.id === current.id ? "step" : undefined}
                          onClick={() => goStep(s.id)}
                        >
                          <span class={`su-toc-dot${state.done[s.id] ? " su-toc-done" : ""}`} aria-hidden="true">
                            {state.done[s.id] ? "✓" : idx(s.id) + 1}
                          </span>
                          <span>{s.title}</span>
                          {state.done[s.id] && <span class="sr-only"> (완료)</span>}
                        </button>
                      </li>
                    ))}
                  </ol>
                </div>
              ))}
            </div>
          </details>
        </div>

        <div class="su-step" key={current.id}>
          <h2 id="su-step-title" ref={headingRef} tabIndex={-1}>
            <span class="su-step-n">{i + 1}</span>
            {current.title}
            <span class="su-step-min">약 {current.minutes}분</span>
          </h2>
          {current.render(stepProps)}
        </div>

        {blockMsg && (
          <p class="error-text su-block" role="alert">
            {blockMsg}
          </p>
        )}
        <nav class="su-nav" aria-label="단계 이동">
          <button type="button" class="btn" onClick={prev} disabled={i === 0}>
            ← 이전
          </button>
          {i < STEPS.length - 1 ? (
            <button type="button" class="btn btn-primary" onClick={next}>
              {state.done[current.id] ? "다음 →" : "다 했어요, 다음 →"}
            </button>
          ) : (
            <span />
          )}
        </nav>
      </section>

      <section class="su-section" aria-labelledby="su-help-title">
        <h2 id="su-help-title">자주 막히는 곳</h2>
        <HelpIndex ctx={ctx} />
      </section>

      <section class="su-section card" id="update" aria-labelledby="su-update-title">
        <h2 id="su-update-title">업데이트하는 법</h2>
        <UpdateSection />
      </section>

      <section class="su-section card" id="cost" aria-labelledby="su-cost-title">
        <h2 id="su-cost-title">비용이 드나요? (무료 한도)</h2>
        <CostSection />
      </section>

      <section class="su-section card" id="privacy" aria-labelledby="su-privacy-title">
        <h2 id="su-privacy-title">학생 개인정보는 어디에 저장되나요?</h2>
        <PrivacySection />
      </section>

      <footer class="su-footer">
        <button
          type="button"
          class="btn btn-ghost btn-small"
          onClick={() => {
            if (!confirm("이 브라우저에 저장된 설치 진행 상황을 지우고 처음부터 할까요? (설치된 나눔보드나 Google 설정은 그대로예요.)")) return;
            clearState();
            setState({ ...EMPTY_STATE, done: {} });
          }}
        >
          진행 상황 지우고 처음부터
        </button>
        {mode === "instance" && (
          <a class="btn btn-small" href="/teacher">
            선생님 화면
          </a>
        )}
      </footer>
    </div>
  );
}
