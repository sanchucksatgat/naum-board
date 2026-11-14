/** 업로드 파일 이름·MIME 검사, 보기 응답의 안전한 헤더 결정. */
import { IMAGE_MIME, INLINE_SAFE_MIME, MAX_FILE_NAME_LENGTH, type AttachmentKind } from "../../shared/files";

/** 수업 보드에 올릴 이유가 없고 위험한 실행 파일 확장자: 업로드 자체를 거부 */
const BLOCKED_EXT = new Set([
  "exe", "msi", "msp", "bat", "cmd", "com", "scr", "pif", "cpl", "ps1", "psm1", "vbs", "vbe", "wsf", "wsh", "hta",
  "jar", "apk", "app", "dmg", "pkg", "deb", "rpm", "sh", "reg", "lnk", "dll", "sys", "iso", "msix", "appx",
]);
const BLOCKED_MIME = new Set([
  "application/x-msdownload", "application/x-msdos-program", "application/x-ms-installer", "application/x-msi",
  "application/vnd.microsoft.portable-executable", "application/x-sh", "application/x-bat", "application/hta",
  "application/java-archive", "application/vnd.android.package-archive", "application/x-apple-diskimage",
]);

const MIME_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/;

export function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1).toLowerCase() : "";
}

/** 파일 이름 정리: 제어문자·경로 구분자 제거, 길이 제한. 비면 null */
export function cleanFileName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let s = raw.normalize("NFC").replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, "").replace(/[\\/]/g, "_").trim();
  if (s === "" || s === "." || s === "..") return null;
  if (s.length > MAX_FILE_NAME_LENGTH) {
    const ext = extOf(s);
    const keep = ext && ext.length < 12 ? "." + ext : "";
    s = s.slice(0, MAX_FILE_NAME_LENGTH - keep.length) + keep;
  }
  return s;
}

/** MIME 정리: 매개변수(;charset) 제거, 소문자. 형식이 이상하면 octet-stream */
export function cleanMime(raw: unknown): string {
  if (typeof raw !== "string") return "application/octet-stream";
  const m = raw.split(";")[0]!.trim().toLowerCase();
  return MIME_RE.test(m) ? m : "application/octet-stream";
}

export type FileCheck = { ok: true; name: string; mime: string; kind: AttachmentKind } | { ok: false; message: string };

export function checkUploadFile(rawName: unknown, rawMime: unknown): FileCheck {
  const name = cleanFileName(rawName);
  if (!name) return { ok: false, message: "파일 이름이 올바르지 않아요." };
  const mime = cleanMime(rawMime);
  if (BLOCKED_EXT.has(extOf(name)) || BLOCKED_MIME.has(mime)) {
    return { ok: false, message: "실행 파일은 올릴 수 없어요. 사진·문서·영상 파일을 올려 주세요." };
  }
  return { ok: true, name, mime, kind: IMAGE_MIME.has(mime) ? "image" : "file" };
}

/** 브라우저에서 바로 열어도 되는가 (html·svg·xml·js 등은 내려받기로) */
export function isInlineSafe(mime: string): boolean {
  return INLINE_SAFE_MIME.has(mime);
}

/** RFC 6266/5987 Content-Disposition */
export function contentDisposition(type: "inline" | "attachment", name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

export function formatMB(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))}KB`;
  const mb = bytes / (1024 * 1024);
  return mb >= 10 ? `${Math.round(mb)}MB` : `${Math.round(mb * 10) / 10}MB`;
}
