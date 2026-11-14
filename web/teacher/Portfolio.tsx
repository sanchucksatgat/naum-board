/** 학생 포트폴리오: 반 → 학생 고르기, 학생 한 명의 여러 보드 카드 모아 보기 (인쇄·PDF 저장) */
import { useEffect, useMemo, useState } from "preact/hooks";
import type { PortfolioResponse, PostView } from "../../src/shared/protocol";
import { api } from "./api";
import { formatDateTime } from "./format";
import { Link, go } from "./nav";
import { compareNumber } from "./roster";
import { Empty, ErrorBox, Loading, useAsync } from "./ui";

export function PortfolioHome(props: { classId: string | null }) {
  const [classes, reload] = useAsync(() => api.classes(), []);
  const classId = props.classId ?? (classes.status === "ok" ? classes.data[0]?.id : undefined) ?? null;
  const [students, reloadStudents] = useAsync(() => (classId ? api.students(classId) : Promise.resolve([])), [classId]);
  const [query, setQuery] = useState("");
  useEffect(() => {
    document.title = "포트폴리오 · 나눔보드";
  }, []);
  const list = useMemo(() => {
    const q = query.trim().toLocaleLowerCase("ko");
    const all = students.status === "ok" ? students.data : [];
    return [...all].sort(compareNumber).filter((s) => !q || `${s.number} ${s.name} ${s.group}`.toLocaleLowerCase("ko").includes(q));
  }, [students, query]);

  return (
    <div class="stack t-page">
      <h1 class="t-h1">학생 포트폴리오</h1>
      <p class="muted">학생 한 명이 여러 보드에 쓴 카드를 모아 보고, 인쇄하거나 PDF로 저장할 수 있어요.</p>
      {classes.status === "loading" && <Loading />}
      {classes.status === "error" && <ErrorBox error={classes.error} onRetry={reload} />}
      {classes.status === "ok" &&
        (classes.data.length === 0 ? (
          <Empty title="아직 반이 없어요.">
            <p class="muted">포트폴리오는 명단에 있는 학생마다 만들어져요.</p>
            <Link href="/teacher/classes" class="btn btn-primary">
              반·명단 만들기
            </Link>
          </Empty>
        ) : (
          <>
            <div class="t-toolbar">
              <div class="field t-grow">
                <label for="pf-class">반</label>
                <select id="pf-class" class="select" value={classId ?? ""} onChange={(e) => go(`/teacher/portfolio?class=${encodeURIComponent(e.currentTarget.value)}`, { replace: true })}>
                  {classes.data.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name} ({c.studentCount}명)
                    </option>
                  ))}
                </select>
              </div>
              <div class="field t-grow">
                <label for="pf-search">학생 찾기</label>
                <input id="pf-search" class="input" type="search" placeholder="학번·이름" value={query} onInput={(e) => setQuery(e.currentTarget.value)} />
              </div>
            </div>
            {students.status === "loading" && <Loading text="명단을 불러오는 중이에요…" />}
            {students.status === "error" && <ErrorBox error={students.error} onRetry={reloadStudents} />}
            {students.status === "ok" &&
              (list.length ? (
                <ul class="t-student-grid">
                  {list.map((s) => (
                    <li key={s.id}>
                      <Link href={`/teacher/students/${s.id}`} class="card t-student-link">
                        <span class="hint">{s.number}</span>
                        <span class="t-strong">{s.name}</span>
                        {s.group && <span class="chip">{s.group}</span>}
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : (
                <Empty title={query ? "찾는 학생이 없어요." : "이 반에 학생이 없어요."} />
              ))}
          </>
        ))}
    </div>
  );
}

export function StudentPortfolio(props: { id: string }) {
  const [data, reload] = useAsync<PortfolioResponse>(() => api.portfolio(props.id), [props.id]);
  useEffect(() => {
    if (data.status === "ok") document.title = `${data.data.student.name} 포트폴리오 · 나눔보드`;
  }, [data]);
  if (data.status === "loading") return <Loading text="포트폴리오를 모으는 중이에요…" />;
  if (data.status === "error") return <ErrorBox error={data.error} onRetry={reload} />;
  const { student, boards } = data.data;
  const total = boards.reduce((n, b) => n + b.posts.length, 0);
  return (
    <div class="stack t-page t-portfolio">
      <p class="no-print">
        <Link href={`/teacher/portfolio?class=${student.classId}`} class="t-back">
          ← 학생 고르기
        </Link>
      </p>
      <div class="t-page-head">
        <div>
          <p class="hint">학생 포트폴리오</p>
          <h1 class="t-h1">
            {student.number} {student.name}
          </h1>
          <p class="hint">
            보드 {boards.length}개 · 카드 {total}장 · {formatDateTime(Date.now())} 기준
          </p>
        </div>
        <button type="button" class="btn btn-primary no-print" onClick={() => window.print()} disabled={!total}>
          인쇄 / PDF로 저장
        </button>
      </div>
      <p class="hint no-print">인쇄 창에서 ‘대상’을 ‘PDF로 저장’으로 고르면 파일로 저장돼요.</p>
      {total === 0 ? (
        <Empty title="아직 쓴 카드가 없어요.">
          <p class="muted">이 학생의 반이 연결된 보드에 카드를 쓰면 여기에 모여요.</p>
        </Empty>
      ) : (
        boards.map((b) => (
          <section key={b.id} class="stack t-pf-board" aria-label={b.title}>
            <h2 class="t-h2">
              {b.title} {b.archived && <span class="chip">보관됨</span>}
            </h2>
            <div class="t-pf-grid">
              {b.posts.map((p) => (
                <PortfolioCard key={p.id} post={p} boardId={b.id} fileToken={b.fileToken} />
              ))}
            </div>
          </section>
        ))
      )}
    </div>
  );
}

function PortfolioCard(props: { post: PostView; boardId: string; fileToken?: string }) {
  const p = props.post;
  const fileUrl = (id: string) => (props.fileToken ? `/api/files/${encodeURIComponent(props.boardId)}/${encodeURIComponent(id)}?t=${encodeURIComponent(props.fileToken)}` : null);
  const images = p.attachments.filter((a) => a.kind === "image");
  const files = p.attachments.filter((a) => a.kind !== "image");
  return (
    <article class="card t-pf-card">
      <div class="row t-gap-1">
        <span class="hint">{formatDateTime(p.createdAt)}</span>
        {p.status === "pending" && <span class="chip chip-warn">승인 대기</span>}
        {p.status === "hidden" && <span class="chip chip-danger">숨김</span>}
      </div>
      {p.title && <h3 class="t-pf-title">{p.title}</h3>}
      {images.map((a) => {
        const src = fileUrl(a.id);
        return src ? (
          <img key={a.id} class="t-pf-img" src={src} alt={a.name} loading="lazy" width={a.width} height={a.height} />
        ) : (
          <p key={a.id} class="hint">
            사진: {a.name}
          </p>
        );
      })}
      {p.body && <p class="t-pf-body">{p.body}</p>}
      {p.link && (
        <p class="t-break">
          <a href={p.link} target="_blank" rel="noopener noreferrer">
            {p.link}
          </a>
        </p>
      )}
      {files.length > 0 && (
        <ul class="t-pf-files">
          {files.map((a) => {
            const href = fileUrl(a.id);
            return <li key={a.id}>{href ? <a href={href}>📎 {a.name}</a> : <>📎 {a.name}</>}</li>;
          })}
        </ul>
      )}
      <p class="hint">
        ♥ {p.likeCount} · 댓글 {p.comments.length}
      </p>
      {p.feedback?.body && (
        <div class="t-pf-feedback">
          <p class="label">선생님 피드백</p>
          <p>{p.feedback.body}</p>
        </div>
      )}
    </article>
  );
}
