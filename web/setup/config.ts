/**
 * 설치 안내가 쓰는 고정값. 원본 저장소 주소는 여기 한 곳에서만 바꾼다.
 * (README.md 의 "Deploy to Cloudflare" 버튼 주소도 같은 저장소를 가리켜야 한다.)
 *
 * ⚠️ 이 저장소는 반드시 **공개(public)** 여야 설치 버튼이 동작한다.
 */
export const SOURCE_REPO_URL = "https://github.com/sanchucksatgat/-";

/** Cloudflare 설치 버튼이 여는 주소 */
export const DEPLOY_URL = `https://deploy.workers.cloudflare.com/?url=${SOURCE_REPO_URL}`;

/** 설치 버튼이 기본으로 제안하는 Worker 이름 (wrangler.jsonc 의 name) */
export const DEFAULT_WORKER_NAME = "nanumboard";

/** 나눔보드가 Google 에 요청하는 권한 범위 (src/worker/auth/google.ts 의 GOOGLE_SCOPES 와 같아야 함) */
export const SCOPES = [
  { value: "openid", desc: "Google 계정으로 로그인" },
  { value: "https://www.googleapis.com/auth/userinfo.email", desc: "로그인한 계정의 이메일 주소 보기" },
  { value: "https://www.googleapis.com/auth/drive.file", desc: "나눔보드가 만든 드라이브 파일만 다루기" },
] as const;

export const LINKS = {
  github: "https://github.com/signup",
  cloudflare: "https://dash.cloudflare.com/sign-up",
  cloudflareWorkers: "https://dash.cloudflare.com/?to=/:account/workers-and-pages",
  gcpNewProject: "https://console.cloud.google.com/projectcreate",
  gcpDriveApi: "https://console.cloud.google.com/apis/library/drive.googleapis.com",
  gcpAuthOverview: "https://console.cloud.google.com/auth/overview",
  gcpBranding: "https://console.cloud.google.com/auth/branding",
  gcpAudience: "https://console.cloud.google.com/auth/audience",
  gcpDataAccess: "https://console.cloud.google.com/auth/scopes",
  gcpClients: "https://console.cloud.google.com/auth/clients",
  googlePermissions: "https://myaccount.google.com/connections",
} as const;
