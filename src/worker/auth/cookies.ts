/** 쿠키 읽기/쓰기 (Hono 의존 없이 쓸 수 있게 Request/문자열 기반). */

export function getCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) {
      const v = part.slice(eq + 1).trim();
      try {
        return decodeURIComponent(v);
      } catch {
        return v;
      }
    }
  }
  return null;
}

export interface CookieOptions {
  maxAge: number;
  path?: string;
  httpOnly?: boolean;
  sameSite?: "Lax" | "Strict" | "None";
}

/** 항상 Secure. 이름이 __Host- 로 시작하면 Path=/ 이고 Domain 없음이어야 한다. */
export function serializeCookie(name: string, value: string, opts: CookieOptions): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${opts.path ?? "/"}`, `Max-Age=${Math.floor(opts.maxAge)}`, "Secure"];
  if (opts.httpOnly !== false) parts.push("HttpOnly");
  parts.push(`SameSite=${opts.sameSite ?? "Lax"}`);
  return parts.join("; ");
}

export function clearCookie(name: string, path = "/"): string {
  return serializeCookie(name, "", { maxAge: 0, path });
}
