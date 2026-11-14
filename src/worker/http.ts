/** 공용 HTTP 오류. 라우트/미들웨어에서 throw 하면 index.ts 의 onError 가 응답으로 바꾼다. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }

  toResponse(): Response {
    return Response.json({ error: { code: this.code, message: this.message } }, { status: this.status });
  }
}

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ESC[ch] ?? ch);
}

/** 사람이 보는 간단한 안내 페이지 (OAuth 오류 등, 프런트 밖에서 보여줄 때). */
export type PageLink = { href: string; label: string };

export function htmlPage(status: number, title: string, message: string, link?: PageLink | PageLink[]): Response {
  const links = link === undefined ? [] : Array.isArray(link) ? link : [link];
  const body = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} - 나눔보드</title>
<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.6;color:#222}a{color:#2563eb}@media(prefers-color-scheme:dark){body{background:#141a17;color:#e8eeea}a{color:#6fd6a2}}</style></head>
<body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>${links.map((l) => `<p><a href="${escapeHtml(l.href)}">${escapeHtml(l.label)}</a></p>`).join("")}</body></html>`;
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}
