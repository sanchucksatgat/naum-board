import type { ComponentChildren } from "preact";

const pad = (n: number) => String(n).padStart(2, "0");

/** "오후 2:05" (오늘) | "11월 3일 오후 2:05" | "2025년 11월 3일" */
export function formatTime(ms: number, now = Date.now()): string {
  const d = new Date(ms);
  const n = new Date(now);
  const h = d.getHours();
  const time = `${h < 12 ? "오전" : "오후"} ${h % 12 === 0 ? 12 : h % 12}:${pad(d.getMinutes())}`;
  if (d.toDateString() === n.toDateString()) return time;
  if (d.getFullYear() === n.getFullYear()) return `${d.getMonth() + 1}월 ${d.getDate()}일 ${time}`;
  return `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일`;
}

/** "1.2MB" */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)}MB`;
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export function isHttpUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

const URL_RE = /\bhttps?:\/\/[^\s<>"'）)\]]+/g;

/** 글 속 주소를 누를 수 있는 링크로 (http/https 만) */
export function Linkified(props: { text: string }): ComponentChildren {
  const out: ComponentChildren[] = [];
  const text = props.text;
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    let url = m[0];
    // 문장 끝 마침표·쉼표는 주소에서 뺀다
    while (/[.,!?;:]$/.test(url)) url = url.slice(0, -1);
    const i = m.index ?? 0;
    if (i > last) out.push(text.slice(last, i));
    out.push(
      <a href={url} target="_blank" rel="noopener noreferrer nofollow">
        {url}
      </a>,
    );
    last = i + url.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return <>{out}</>;
}

export function fileIcon(mime: string): string {
  if (mime.startsWith("image/")) return "🖼️";
  if (mime.startsWith("video/")) return "🎬";
  if (mime.startsWith("audio/")) return "🎵";
  if (mime === "application/pdf") return "📕";
  if (/sheet|excel|csv/.test(mime)) return "📊";
  if (/presentation|powerpoint/.test(mime)) return "📽️";
  if (/word|document|text/.test(mime)) return "📄";
  if (/zip|compressed/.test(mime)) return "🗜️";
  return "📎";
}
