import { useEffect, useRef, useState } from "preact/hooks";
import type { BoardPublicInfo, StudentInfo } from "../../src/shared/protocol";
import { DEFAULT_PIN, LIMITS } from "../../src/shared/protocol";
import { ApiError, formatWait, studentApi } from "./api";
import { getDeviceToken, getRemembered, setRemembered, type RememberedStudent } from "./storage";
import { Spinner } from "../ui/Spinner";

/** 학생 입장 화면: 명단(학번+PIN, 또는 보드 설정에 따라 학번만) | 자유(닉네임) */
export function Entry(props: {
  code: string;
  info: BoardPublicInfo;
  message?: string | null;
  onEntered: (token: string, student: StudentInfo, opts?: { defaultPin?: boolean }) => void;
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
    setNow(Date.now());
    if (!until || until <= Date.now()) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [until]);
  return until ? Math.max(0, until - now) : 0;
}

function digitsOnly(v: string, max: number) {
  return v.replace(/\D/g, "").slice(0, max);
}

type Entered = (token: string, student: StudentInfo, opts?: { defaultPin?: boolean }) => void;

function RosterEntry(props: { code: string; info: BoardPublicInfo; onEntered: Entered }) {
  return props.info.requirePin === false ? <NumberOnlyEntry {...props} /> : <PinEntry {...props} />;
}

/** 이 기기에서 마지막으로 들어온 학생 */
function useRemembered(code: string) {
  const [remembered, setRememberedState] = useState<RememberedStudent | null>(() => {
    const r = getRemembered(code);
    return r?.number ? r : null;
  });
  const forget = () => {
    setRemembered(code, null);
    setRememberedState(null);
  };
  return [remembered, forget] as const;
}

function WhoCard(props: { who: RememberedStudent; onOther: () => void }) {
  return (
    <div class="entry-who">
      <span class="entry-who-icon" aria-hidden="true">
        🙂
      </span>
      <div class="entry-who-text">
        <strong>{props.who.name || "학생"}</strong>
        <span class="muted">학번 {props.who.number}</span>
      </div>
      <button type="button" class="btn btn-small" onClick={props.onOther}>
        다른 사람이에요
      </button>
    </div>
  );
}

function NumberField(props: { value: string; onInput: (v: string) => void; inputRef: preact.RefObject<HTMLInputElement>; hint?: string }) {
  return (
    <div class="field">
      <label for="entry-number">학번</label>
      <input
        ref={props.inputRef}
        id="entry-number"
        class="input entry-input"
        inputMode="numeric"
        autoComplete="off"
        maxLength={LIMITS.studentNumber}
        placeholder="예: 20301"
        value={props.value}
        aria-describedby={props.hint ? "entry-number-hint" : undefined}
        onInput={(e) => props.onInput((e.currentTarget as HTMLInputElement).value.replace(/\s/g, ""))}
      />
      {props.hint ? (
        <span id="entry-number-hint" class="hint">
          {props.hint}
        </span>
      ) : null}
    </div>
  );
}

function entryError(err: unknown): string {
  return err instanceof ApiError ? err.message : "잠시 문제가 생겼어요. 다시 해 주세요.";
}

/** PIN 없이 들어오는 보드: 학번 → "○○○ 맞나요?" → 들어가기 */
function NumberOnlyEntry(props: { code: string; onEntered: Entered }) {
  const [remembered, forget] = useRemembered(props.code);
  const [number, setNumber] = useState(remembered?.number ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lockedUntil, setLockedUntil] = useState<number | null>(null);
  const [confirm, setConfirm] = useState<{ token: string; student: StudentInfo } | null>(null);
  const wait = useCountdown(lockedUntil);
  const numberRef = useRef<HTMLInputElement>(null);
  const yesRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (confirm) yesRef.current?.focus();
    else if (!remembered) numberRef.current?.focus();
  }, [confirm, remembered]);

  const enter = (token: string, student: StudentInfo) => {
    setRemembered(props.code, { number: student.number, name: student.name });
    props.onEntered(token, student);
  };

  const submit = async (e: Event) => {
    e.preventDefault();
    setError(null);
    const n = (remembered?.number ?? number).trim();
    if (!n) return setError("학번을 써 주세요.");
    setBusy(true);
    try {
      const r = await studentApi.login(props.code, { number: n });
      // 이 기기에서 전에 들어온 학생이면 바로, 아니면 이름을 확인하고 들어간다
      if (remembered) enter(r.token, r.student);
      else setConfirm({ token: r.token, student: r.student });
    } catch (err) {
      setError(entryError(err));
      if (err instanceof ApiError && err.code === "too_many_attempts" && err.retryAfterMs) setLockedUntil(Date.now() + err.retryAfterMs);
      numberRef.current?.focus();
    } finally {
      setBusy(false);
    }
  };

  if (confirm) {
    const name = confirm.student.realName || confirm.student.name;
    return (
      <div class="stack">
        <div class="entry-confirm" role="status">
          <span class="entry-who-icon" aria-hidden="true">
            🙂
          </span>
          <p class="entry-confirm-q">
            <strong>{name}</strong> 맞나요?
          </p>
          <p class="muted">학번 {confirm.student.number}</p>
        </div>
        <button ref={yesRef} type="button" class="btn btn-primary entry-submit" onClick={() => enter(confirm.token, confirm.student)}>
          네, 맞아요
        </button>
        <button
          type="button"
          class="btn"
          onClick={() => {
            setConfirm(null);
            setNumber("");
          }}
        >
          아니에요 (학번 다시 쓰기)
        </button>
      </div>
    );
  }

  const locked = wait > 0;
  return (
    <form class="stack" onSubmit={submit} noValidate>
      {remembered ? (
        <WhoCard
          who={remembered}
          onOther={() => {
            forget();
            setNumber("");
            setError(null);
          }}
        />
      ) : (
        <NumberField value={number} onInput={setNumber} inputRef={numberRef} hint="내 학번을 써요. 친구 학번으로 들어가면 안 돼요." />
      )}
      {error ? (
        <p class="error-text" role="alert">
          {error}
          {locked ? ` (${formatWait(wait)} 남았어요)` : ""}
        </p>
      ) : null}
      <button class="btn btn-primary entry-submit" type="submit" disabled={busy || locked}>
        {busy ? <Spinner label="확인하는 중" /> : locked ? `${formatWait(wait)} 뒤에 다시 해요` : remembered ? "들어가기" : "다음"}
      </button>
    </form>
  );
}

/** 학번 + PIN (처음 PIN 은 모두 1234, 바꿨으면 나만의 PIN) */
function PinEntry(props: { code: string; onEntered: Entered }) {
  const [remembered, forget] = useRemembered(props.code);
  const [number, setNumber] = useState(remembered?.number ?? "");
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lockedUntil, setLockedUntil] = useState<number | null>(null);
  const wait = useCountdown(lockedUntil);
  const pinRef = useRef<HTMLInputElement>(null);
  const numberRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    (remembered ? pinRef : numberRef).current?.focus();
  }, [remembered]);

  const submit = async (e: Event) => {
    e.preventDefault();
    setError(null);
    const n = (remembered?.number ?? number).trim();
    if (!n) return setError("학번을 써 주세요.");
    if (!/^\d{4}$/.test(pin)) return setError("PIN 숫자 4자리를 써 주세요.");
    setBusy(true);
    try {
      const r = await studentApi.login(props.code, { number: n, pin });
      setRemembered(props.code, { number: r.student.number ?? n, name: r.student.name });
      props.onEntered(r.token, r.student, { defaultPin: !!r.defaultPin });
    } catch (err) {
      setPin("");
      setError(entryError(err));
      if (err instanceof ApiError && (err.code === "student_locked" || err.code === "too_many_attempts") && err.retryAfterMs) {
        setLockedUntil(Date.now() + err.retryAfterMs);
      }
      pinRef.current?.focus();
    } finally {
      setBusy(false);
    }
  };

  const locked = wait > 0;
  return (
    <form class="stack" onSubmit={submit} noValidate>
      {remembered ? (
        <WhoCard
          who={remembered}
          onOther={() => {
            forget();
            setNumber("");
            setPin("");
            setError(null);
          }}
        />
      ) : (
        <NumberField value={number} onInput={setNumber} inputRef={numberRef} />
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
          처음 PIN은 {DEFAULT_PIN}예요. 나만의 PIN으로 바꿨다면 그 번호를 써요.
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

function FreeEntry(props: { code: string; onEntered: Entered }) {
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
