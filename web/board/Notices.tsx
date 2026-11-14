import { useState } from "preact/hooks";
import { useBoard, useView } from "./ctx";
import { formatTime, Linkified } from "./format";

/** 공지 (최신 먼저). 휴대폰에서는 가장 최근 것 하나만 펼쳐 보이고 나머지는 "더 보기". */
export function Notices() {
  const ctx = useBoard();
  const notices = useView((v) => v.notices);
  const [all, setAll] = useState(false);
  const T = ctx.teacher;
  if (!notices.length && !T) return null;
  if (!notices.length && ctx.projector) return null;
  const list = all ? notices : notices.slice(0, ctx.projector ? 3 : 1);
  return (
    <section class="notices" aria-label="공지">
      {list.map((n) => (
        <article key={n.id} class="notice">
          <div class="notice-head">
            <span class="notice-icon" aria-hidden="true">
              📢
            </span>
            <h2 class="notice-title">{n.title || "공지"}</h2>
            <span class="hint">{formatTime(n.updatedAt || n.createdAt)}</span>
            {T && !ctx.projector && !n.id.startsWith("tmp:") ? <T.NoticeActions noticeId={n.id} /> : null}
          </div>
          {n.body ? (
            <p class="notice-body">
              <Linkified text={n.body} />
            </p>
          ) : null}
        </article>
      ))}
      <div class="row notices-foot">
        {notices.length > 1 && !ctx.projector ? (
          <button type="button" class="btn btn-small btn-ghost" aria-expanded={all} onClick={() => setAll(!all)}>
            {all ? "공지 접기" : `공지 ${notices.length - 1}개 더 보기`}
          </button>
        ) : null}
        {T && !ctx.projector ? <T.NewNoticeButton compact={notices.length > 0} /> : null}
      </div>
    </section>
  );
}
