import type { MeResponse } from "../../src/shared/api";

/** GET /api/me */
export async function fetchMe(): Promise<MeResponse> {
  const res = await fetch("/api/me", { credentials: "same-origin" });
  if (!res.ok) throw new Error(`/api/me ${res.status}`);
  return (await res.json()) as MeResponse;
}
