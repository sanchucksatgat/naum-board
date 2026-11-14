import { Component } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { ColumnView } from "../../src/shared/protocol";
import { myOnlyPost, orphanPostIds, postIdsForColumn, shallowEqualArray, type ServerState } from "../lib/realtime";
import { CardShell } from "./Card";
import { useBoard, useView, type ComposeTarget } from "./ctx";

/** 카드 벽: 열 여러 개. 휴대폰에서는 열이 세로로 쌓이고 위에 "칸 이동"이 붙는다. */
export function Wall() {
  const ctx = useBoard();
  const columns = useView((v) => v.columns);
  const mode = useView((v) => v.settings.columnMode);
  const hasOrphans = useView((v) => orphanPostIds(v).length > 0);
  const T = ctx.teacher;
  const visibleCols = columns;

  return (
    <>
      {!ctx.projector ? <ColumnJump columns={visibleCols} /> : null}
      <div class={"wall wall-" + mode + (ctx.projector ? " wall-projector" : "")} role="list" aria-label="카드 칸">
        {visibleCols.map((c, i) => (
          <ColumnShell key={c.id} column={ctx.projector && ctx.hideNames && c.kind === "student" ? { ...c, title: `학생 ${i}` } : c} />
        ))}
        {hasOrphans ? <OrphanColumn /> : null}
        {T && mode === "topic" && !ctx.projector ? (
          <div class="wall-add-col" role="listitem">
            <T.AddColumn />
          </div>
        ) : null}
      </div>
    </>
  );
}

export function colDomId(id: string): string {
  return "col-" + id.replace(/[^A-Za-z0-9_-]/g, (ch) => "_" + ch.charCodeAt(0).toString(16));
}

function scrollToCol(id: string) {
  const el = document.getElementById(colDomId(id));
  if (!el) return;
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  el.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start", inline: "start" });
  // 머리글에 초점을 줘서 화면 읽기 도구도 따라가게
  el.querySelector<HTMLElement>(".col-head h2")?.focus({ preventScroll: true });
}

/** 휴대폰: 칸 이동 + 내 칸으로 가기 */
function ColumnJump(props: { columns: ColumnView[] }) {
  const mine = props.columns.find((c) => c.mine);
  const mode = useView((v) => v.settings.columnMode);
  const [value, setValue] = useState("");
  if (props.columns.length < 2) return null;
  return (
    <div class="col-jump">
      <label class="sr-only" for="col-jump-select">
        {mode === "group" ? "모둠 칸으로 이동" : mode === "topic" ? "주제 칸으로 이동" : "친구 칸으로 이동"}
      </label>
      <select
        id="col-jump-select"
        class="select col-jump-select"
        value={value}
        onChange={(e) => {
          const id = (e.currentTarget as HTMLSelectElement).value;
          setValue("");
          if (id) scrollToCol(id);
        }}
      >
        <option value="">{mode === "group" ? "👀 모둠 칸 이동" : mode === "topic" ? "👀 주제 칸 이동" : "👀 친구 칸 이동"}</option>
        {props.columns.map((c) => (
          <option key={c.id} value={c.id}>
            {c.title}
            {c.mine ? " (내 칸)" : ""}
          </option>
        ))}
      </select>
      {mine ? (
        <button type="button" class="btn btn-primary col-jump-mine" onClick={() => scrollToCol(mine.id)}>
          🙋 내 칸으로 가기
        </button>
      ) : null}
    </div>
  );
}

class ColumnShell extends Component<{ column: ColumnView }> {
  override shouldComponentUpdate(next: { column: ColumnView }) {
    return next.column !== this.props.column;
  }
  render() {
    return <Column column={this.props.column} />;
  }
}

function composeTarget(v: ServerState, col: ColumnView, role: "teacher" | "student"): { target: ComposeTarget; label: string } | null {
  const s = v.settings;
  if (role === "student" && s.locked) return null;
  if (role === "student" && s.archived) return null;
  if (role === "teacher" && s.archived) return null;
  const mine = myOnlyPost(v);
  if (s.columnMode === "topic") {
    if (mine) return null; // 단일 주제: 이미 썼으면 열 머리에는 안 보임 (내 카드에서 고치기)
    return { target: { columnId: col.id }, label: "＋ 글쓰기" };
  }
  if (role === "teacher") {
    if (col.kind === "teacher") return { target: {}, label: "＋ 선생님 글쓰기" };
    if (col.kind === "student" && col.ownerRef && s.entryMode === "roster") return { target: { onBehalfOf: col.ownerRef }, label: "＋ 대신 쓰기" };
    return null;
  }
  if (!col.mine) return null;
  if (mine) return { target: { editId: mine.id }, label: "✏️ 내 카드 고치기" };
  return { target: {}, label: "＋ 글쓰기" };
}

function Column(props: { column: ColumnView }) {
  const ctx = useBoard();
  const c = props.column;
  const ids = useView((v) => postIdsForColumn(v, c.id), shallowEqualArray);
  const compose = useView(
    (v) => (ctx.projector ? null : composeTarget(v, c, ctx.role)),
    (a, b) => a === b || (!!a && !!b && a.label === b.label && a.target.editId === b.target.editId),
  );
  const notSubmitted = useView((v) => (ctx.role === "teacher" && !ctx.projector && c.ownerRef ? !!v.notSubmitted?.includes(c.ownerRef) : false));
  const mode = useView((v) => v.settings.columnMode);
  const showAuthor = mode !== "student" || c.kind === "teacher" ? true : false;
  const T = ctx.teacher;
  const headId = colDomId(c.id) + "-h";

  return (
    <section id={colDomId(c.id)} class={"col" + (c.mine ? " is-mine" : "") + " col-" + c.kind} role="listitem" aria-labelledby={headId}>
      <header class="col-head">
        <h2 id={headId} class="col-title" tabIndex={-1}>
          {c.kind === "teacher" ? "🍎 " : ""}
          {c.title}
        </h2>
        <span class="col-count">
          {c.mine ? <span class="chip chip-primary">내 칸</span> : null}
          {notSubmitted ? <span class="chip chip-warn">아직 안 씀</span> : null}
          <span class="muted">{ids.length}</span>
        </span>
        {T && mode === "topic" && !ctx.projector ? <T.ColumnMenu columnId={c.id} /> : null}
      </header>
      {compose ? (
        <button type="button" class="col-add" onClick={() => ctx.openComposer(compose.target)}>
          {compose.label}
        </button>
      ) : null}
      <div class="col-cards">
        {ids.map((id) => (
          <CardShell key={id} id={id} showAuthor={showAuthor} />
        ))}
        {ids.length === 0 ? <p class="col-empty">{ctx.projector ? "" : "아직 카드가 없어요 🌱"}</p> : null}
      </div>
    </section>
  );
}

function OrphanColumn() {
  const ids = useView((v) => orphanPostIds(v), shallowEqualArray);
  return (
    <section class="col col-orphan" role="listitem" aria-label="열이 없는 카드">
      <header class="col-head">
        <h2 class="col-title">📦 기타</h2>
        <span class="col-count muted">{ids.length}</span>
      </header>
      <div class="col-cards">
        {ids.map((id) => (
          <CardShell key={id} id={id} showAuthor />
        ))}
      </div>
    </section>
  );
}

/** 휴대폰 너비인지 (열 이동 막대·떠 있는 글쓰기 단추에 씀) */
export function usePhone(): boolean {
  const [phone, setPhone] = useState(() => matchMedia("(max-width: 640px)").matches);
  useEffect(() => {
    const mq = matchMedia("(max-width: 640px)");
    const fn = () => setPhone(mq.matches);
    mq.addEventListener("change", fn);
    return () => mq.removeEventListener("change", fn);
  }, []);
  return phone;
}
