/** PIN 쪽지 인쇄: A4 한 장에 N개, 자르는 선, 학번순 */
import { useEffect, useMemo, useState } from "preact/hooks";
import type { BoardSummary, TeacherStudent } from "../../src/shared/protocol";
import { api } from "./api";
import { spacedCode } from "./format";
import { Link, go } from "./nav";
import { compareNumber, paginate } from "./roster";
import { Empty, ErrorBox, Loading, Toggle, useAsync } from "./ui";

const LAYOUTS = [
  { perPage: 8, cols: 2, label: "8개 (크게)" },
  { perPage: 12, cols: 2, label: "12개" },
  { perPage: 21, cols: 3, label: "21개 (작게)" },
] as const;

export function PinSlips(props: { classId: string; boardId: string | null }) {
  const [data, reload] = useAsync(async () => {
    const [classes, students, boards] = await Promise.all([api.classes(), api.students(props.classId), api.boards("0")]);
    const cls = classes.find((c) => c.id === props.classId);
    if (!cls) throw new Error("반을 찾을 수 없어요.");
    return { cls, students, boards: boards.filter((b) => b.classId === props.classId && b.entryMode === "roster") };
  }, [props.classId]);
  const [perPage, setPerPage] = useState<number>(12);
  const [includeRegistered, setIncludeRegistered] = useState(false);

  useEffect(() => {
    document.title = "PIN 쪽지 · 나눔보드";
  }, []);

  const boards: BoardSummary[] = data.status === "ok" ? data.data.boards : [];
  const board = boards.find((b) => b.id === props.boardId) ?? (props.boardId ? undefined : boards[0]);
  const students: TeacherStudent[] = data.status === "ok" ? data.data.students : [];
  const slips = useMemo(() => [...students].sort(compareNumber).filter((s) => includeRegistered || !s.pinRegistered), [students, includeRegistered]);
  const layout = LAYOUTS.find((l) => l.perPage === perPage) ?? LAYOUTS[1];
  const pages = paginate(slips, layout.perPage);
  const host = location.host;

  if (data.status === "loading") return <Loading text="명단을 불러오는 중이에요…" />;
  if (data.status === "error") return <ErrorBox error={data.error} onRetry={reload} />;
  const { cls } = data.data;
  const registeredCount = students.filter((s) => s.pinRegistered).length;

  return (
    <div class="stack t-page">
      <div class="no-print stack">
        <p>
          <Link href={`/teacher/classes/${cls.id}`} class="t-back">
            ← {cls.name} 명단
          </Link>
        </p>
        <div class="t-page-head">
          <h1 class="t-h1">PIN 쪽지 인쇄</h1>
          <button type="button" class="btn btn-primary" onClick={() => window.print()} disabled={!slips.length}>
            인쇄하기
          </button>
        </div>
        <p class="muted">
          쪽지를 잘라 한 명씩 나눠 주세요. 학생은 처음 들어올 때 이 초기 PIN을 넣고, 바로 ‘나만의 PIN’을 정해요. 그 뒤에는 초기 PIN을 쓸 수 없어요.
        </p>
        <div class="card t-print-controls">
          <div class="field">
            <label for="ps-board">쪽지에 적을 보드</label>
            {boards.length ? (
              <select
                id="ps-board"
                class="select"
                value={board?.id ?? ""}
                onChange={(e) => go(`/teacher/classes/${cls.id}/pins?board=${encodeURIComponent(e.currentTarget.value)}`, { replace: true })}
              >
                {boards.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.title} ({b.code})
                  </option>
                ))}
                <option value="none">보드 없이 (입장 코드 빈칸)</option>
              </select>
            ) : (
              <p class="hint">이 반에 연결된 명단 입장 보드가 없어서 입장 코드는 빈칸으로 나와요.</p>
            )}
          </div>
          <div class="field">
            <label for="ps-layout">한 장에</label>
            <select id="ps-layout" class="select" value={String(perPage)} onChange={(e) => setPerPage(Number(e.currentTarget.value))}>
              {LAYOUTS.map((l) => (
                <option key={l.perPage} value={l.perPage}>
                  {l.label}
                </option>
              ))}
            </select>
          </div>
          <Toggle
            label={`나만의 PIN을 정한 학생도 넣기 (${registeredCount}명)`}
            hint="이 학생들은 PIN 대신 ‘나만의 PIN 사용 중’이라고 나와요."
            checked={includeRegistered}
            onChange={setIncludeRegistered}
          />
        </div>
        <p class="hint">
          쪽지 {slips.length}장 · A4 {pages.length}쪽. 인쇄 창에서 ‘배경 그래픽’은 꺼도 되고, 용지는 A4, 배율은 ‘기본’으로 두세요.
        </p>
      </div>

      {!slips.length ? (
        <Empty title={students.length ? "인쇄할 쪽지가 없어요." : "명단에 학생이 없어요."}>
          <p class="muted">{students.length ? "모든 학생이 나만의 PIN을 정했어요. 위에서 ‘정한 학생도 넣기’를 켜면 인쇄할 수 있어요." : "먼저 명단에 학생을 넣어 주세요."}</p>
        </Empty>
      ) : (
        <div class="t-slip-pages" aria-label="PIN 쪽지 미리보기">
          {pages.map((page, i) => (
            <section key={i} class={`t-slip-page t-cols-${layout.cols} t-per-${layout.perPage}`} aria-label={`${i + 1}쪽`}>
              {page.map((s) => (
                <article key={s.id} class="t-slip">
                  <p class="t-slip-top">
                    <span>나눔보드</span>
                    <span>
                      입장 코드 <strong>{board ? spacedCode(board.code) : "＿＿＿ ＿＿＿"}</strong>
                    </span>
                  </p>
                  {board && <p class="t-slip-board">{board.title}</p>}
                  <p class="t-slip-name">
                    {s.number} {s.name}
                  </p>
                  {s.pinRegistered ? (
                    <p class="t-slip-pin is-registered">나만의 PIN 사용 중</p>
                  ) : (
                    <p class="t-slip-pin" aria-label={`초기 PIN ${s.initialPin ?? ""}`}>
                      {s.initialPin ?? "————"}
                    </p>
                  )}
                  <p class="t-slip-help">
                    {host}/b/{board?.code ?? "코드"} → 학번과 {s.pinRegistered ? "나만의 PIN" : "이 PIN"} 입력
                    {s.pinRegistered ? "" : " → 나만의 PIN 정하기"}
                  </p>
                </article>
              ))}
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
