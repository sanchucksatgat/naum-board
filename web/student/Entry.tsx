import { useEffect, useRef, useState } from "preact/hooks";
import type { BoardPublicInfo, StudentInfo } from "../../src/shared/protocol";
import { LIMITS } from "../../src/shared/protocol";
import { ApiError, formatWait, studentApi } from "./api";
import { getDeviceToken, getRemembered, setRemembered, type RememberedStudent } from "./storage";
import { Spinner } from "../ui/Spinner";

/** 학생 입장 화면: 명단(학번+PIN, 처음이면 나만의 PIN 정하기) | 자유(닉네임) */
export function Entry(props: {
  code: string;
  info: BoardPublicInfo;
  message?: string | null;
  onEntered: (token: string, student: StudentInfo) => void;
}) {
  return (
    <main class="entry">
      <div class="entry-card card">
        <p class="entry-brand">🌱 나눔보드</p>
        <h1 class="entry-title">{props.info.title}</h1>
        {props.info.locked ? <p class="chip chip-warn entry-chip">🔒 지금은 볼 수만 있어요</p> : null}
        {props.message ? (
          <p class="entry-alert" role="alert">
            {props.message}
          </p>
        ) : null}
        {props.info.entryMode === "roster" ? <RosterEntry {...props} /> : <FreeEntry {...props} />}
      </div>
      <p class="entry-foot muted">
        입장코드 <strong class="entry-code">{props.info.code}</strong>
      </p>
    </main>
  );
}

function useCountdown(until: number | null): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!until || until <= Date.now()) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [until]);
  return until ? Math.max(0, until - now) : 0;
}

function digitsOnly(v: string, max: number) {
  return v.replace(/\D/g, "").slice(0, max);
}

function RosterEntry(props: { code: string; onEntered: (token: string, student: StudentInfo) => void }) {
  const [remembered, setRememberedState] = useState<RememberedStudent | null>(() => {
    const r = getRemembered(props.code);
    return r?.number ? r : null;
  });
  const [number, setNumber] = useState(remembered?.number ?? "");
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lockedUntil, setLockedUntil] = useState<number | null>(null);
  const [setup, setSetup] = useState<{ setupToken: string; student: StudentInfo } | null>(null);
  const wait = useCountdown(lockedUntil);
  const pinRef = useRef<HTMLInputElement>(null);
  const numberRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    (remembered ? pinRef : numberRef).current?.focus();
  }, [remembered]);

  if (setup) {
    return (
      <PinSetup
        code={props.code}
        setupToken={setup.setupToken}
        student={setup.student}
        onBack={() => {
          setSetup(null);
          setPin("");
        }}
        onDone={(token, student) => {
          setRemembered(props.code, { number: student.number, name: student.name });
          props.onEntered(token, student);
        }}
      />
    );
  }

  const submit = async (e: Event) => {
    e.preventDefault();
    setError(null);
    const n = number.trim();
    if (!n) return setError("학번을 써 주세요.");
    if (!/^\d{4}$/.test(pin)) return setError("PIN 숫자 4자리를 써 주세요.");
    setBusy(true);
    try {
      const r = await studentApi.login(props.code, { number: n, pin });
      if (r.status === "pin_setup") {
        setSetup({ setupToken: r.setupToken, student: r.student });
      } else {
        setRemembered(props.code, { number: r.student.number ?? n, name: r.student.name });
        props.onEntered(r.token, r.student);
      }
    } catch (err) {
      setPin("");
      if (err instanceof ApiError) {
        setError(err.message);
        if ((err.code === "student_locked" || err.code === "too_many_attempts") && err.retryAfterMs) {
          setLockedUntil(Date.now() + err.retryAfterMs);
        }
      } else setError("잠시 문제가 생겼어요. 다시 해 주세요.");
      pinRef.current?.focus();
    } finally {
      setBusy(false);
    }
  };

  const locked = wait > 0;
  return (
    <form class="stack" onSubmit={submit} noValidate>
      {remembered ? (
        <div class="entry-who">
          <span class="entry-who-icon" aria-hidden="true">
            🙂
          </span>
          <div class="entry-who-text">
            <strong>{remembered.name || "학생"}</strong>
            <span class="muted">학번 {remembered.number}</span>
          </div>
          <button
            type="button"
            class="btn btn-small"
            onClick={() => {
              setRemembered(props.code, null);
              setRememberedState(null);
              setNumber("");
              setPin("");
              setError(null);
            }}
          >
            다른 사람이에요
          </button>
        </div>
      ) : (
        <div class="field">
          <label for="entry-number">학번</label>
          <input
            ref={numberRef}
            id="entry-number"
            class="input entry-input"
            inputMode="numeric"
            autoComplete="off"
            maxLength={LIMITS.studentNumber}
            placeholder="예: 20301"
            value={number}
            onInput={(e) => setNumber((e.currentTarget as HTMLInputElement).value.replace(/\s/g, ""))}
          />
        </div>
      )}
      <div class="field">
        <label for="entry-pin">PIN 4자리</label>
        <input
          ref={pinRef}
          id="entry-pin"
          class="input entry-input entry-pin"
          type="password"
          inputMode="numeric"
          autoComplete="off"
          maxLength={4}
          placeholder="••••"
          value={pin}
          aria-describedby="entry-pin-hint"
          onInput={(e) => setPin(digitsOnly((e.currentTarget as HTMLInputElement).value, 4))}
        />
        <span id="entry-pin-hint" class="hint">
          처음이면 선생님이 준 쪽지의 PIN을 써요.
        </span>
      </div>
      {error ? (
        <p class="error-text" role="alert">
          {error}
          {locked ? ` (${formatWait(wait)} 남았어요)` : ""}
        </p>
      ) : null}
      <button class="btn btn-primary entry-submit" type="submit" disabled={busy || locked}>
        {busy ? <Spinner label="확인하는 중" /> : locked ? `${formatWait(wait)} 뒤에 다시 해요` : "들어가기"}
      </button>
    </form>
  );
}

const WEAK_PINS = new Set(["0000", "1111", "1234"]);

function PinSetup(props: {
  code: string;
  setupToken: string;
  student: StudentInfo;
  onBack: () => void;
  onDone: (token: string, student: StudentInfo) => void;
}) {
  const [a, setA] = useState("");
  const [b, setB] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => first.current?.focus(), []);

  const submit = async (e: Event) => {
    e.preventDefault();
    setError(null);
    if (!/^\d{4}$/.test(a)) return setError("숫자 4자리로 정해 주세요.");
    if (WEAK_PINS.has(a) || /^(\d)\1{3}$/.test(a)) return setError("너무 쉬운 PIN이에요. 다른 숫자로 정해 주세요.");
    if (a !== b) return setError("두 번 쓴 PIN이 달라요. 다시 써 주세요.");
    setBusy(true);
    try {
      const r = await studentApi.setPin(props.code, { setupToken: props.setupToken, newPin: a });
      props.onDone(r.token, r.student);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "잠시 문제가 생겼어요. 다시 해 주세요.");
      if (err instanceof ApiError && err.code === "unauthorized") setTimeout(props.onBack, 1500);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form class="stack" onSubmit={submit} noValidate>
      <div class="entry-welcome">
        <strong>{props.student.name}</strong> 님, 반가워요! 👋
        <br />
        이제 <strong>나만의 PIN</strong>을 정해요. 다음부터는 이 PIN으로 들어와요.
      </div>
      <div class="field">
        <label for="pin-new">새 PIN 4자리</label>
        <input
          ref={first}
          id="pin-new"
          class="input entry-input entry-pin"
          type="password"
          inputMode="numeric"
          autoComplete="new-password"
          maxLength={4}
          value={a}
          onInput={(e) => setA(digitsOnly((e.currentTarget as HTMLInputElement).value, 4))}
        />
      </div>
      <div class="field">
        <label for="pin-again">한 번 더</label>
        <input
          id="pin-again"
          class="input entry-input entry-pin"
          type="password"
          inputMode="numeric"
          autoComplete="new-password"
          maxLength={4}
          value={b}
          onInput={(e) => setB(digitsOnly((e.currentTarget as HTMLInputElement).value, 4))}
        />
        <span class="hint">0000, 1111, 1234 처럼 쉬운 숫자와 쪽지의 PIN은 쓸 수 없어요. 친구에게 알려 주지 마세요.</span>
      </div>
      {error ? (
        <p class="error-text" role="alert">
          {error}
        </p>
      ) : null}
      <button class="btn btn-primary entry-submit" type="submit" disabled={busy}>
        {busy ? <Spinner label="저장하는 중" /> : "PIN 정하고 들어가기"}
      </button>
      <button type="button" class="btn btn-ghost" onClick={props.onBack}>
        ← 처음으로
      </button>
    </form>
  );
}

function FreeEntry(props: { code: string; onEntered: (token: string, student: StudentInfo) => void }) {
  const remembered = getRemembered(props.code);
  const [nickname, setNickname] = useState(remembered?.nickname ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.focus(), []);

  const submit = async (e: Event) => {
    e.preventDefault();
    setError(null);
    const n = nickname.trim();
    if (!n) return setError("친구들에게 보일 이름을 써 주세요.");
    setBusy(true);
    try {
      const r = await studentApi.join(props.code, { nickname: n, deviceToken: getDeviceToken() });
      setRemembered(props.code, { nickname: r.student.nickname || n });
      props.onEntered(r.token, r.student);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "잠시 문제가 생겼어요. 다시 해 주세요.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form class="stack" onSubmit={submit} noValidate>
      <div class="field">
        <label for="entry-nick">내 이름 (닉네임)</label>
        <input
          ref={ref}
          id="entry-nick"
          class="input entry-input"
          maxLength={LIMITS.nickname}
          autoComplete="off"
          placeholder="예: 별빛"
          value={nickname}
          onInput={(e) => setNickname((e.currentTarget as HTMLInputElement).value)}
        />
        <span class="hint">전화번호·주소 같은 개인정보는 쓰지 않아요. 같은 기기로 다시 오면 내 카드를 이어서 고칠 수 있어요.</span>
      </div>
      {error ? (
        <p class="error-text" role="alert">
          {error}
        </p>
      ) : null}
      <button class="btn btn-primary entry-submit" type="submit" disabled={busy}>
        {busy ? <Spinner label="들어가는 중" /> : "들어가기"}
      </button>
    </form>
  );
}
