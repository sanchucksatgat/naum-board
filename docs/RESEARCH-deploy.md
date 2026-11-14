# 배포·Google OAuth 조사 (태스크1)

조사일: 2026-11-14. 설치 안내(후속 태스크)의 근거 자료.

**확인 수준 표시**
- ✅ **원문 확인**: 공식 문서 원문을 직접 읽음. Cloudflare 문서는 developers.cloudflare.com 접속이 이 작업 환경에서 막혀 있어서, 같은 내용의 GitHub 원본(`cloudflare/cloudflare-docs` 저장소 `production` 브랜치의 .mdx)을 읽었다.
- 🔎 **검색 요약만**: developers.google.com, support.google.com 은 이 환경에서 직접 열 수 없었다(DNS 차단). 웹 검색 결과 요약으로만 확인. 원문을 다시 확인해야 한다.
- ❓ **미확인**: 근거를 찾지 못했거나 기억에 의존한 내용. 설치 안내를 쓰기 전에 실제로 확인할 것.

---

## (a) openid · email · drive.file 만 쓰는 OAuth 앱을 검증 없이 "프로덕션"으로 게시할 수 있나

결론: **된다(🔎).** 경고 화면과 사용자 100명 제한은 민감(sensitive)·제한(restricted) 범위를 검증 없이 요청할 때만 붙는다. `drive.file` 은 Google 이 "권장 · 비민감(Non-sensitive)" 범위로 분류한다. `openid`, `email` 도 기본(비민감) 범위다.

- 🔎 Drive 범위 표에서 `drive.file` 은 *Recommended, Non-sensitive* 이고, 전체 `drive` 와 `drive.metadata(.readonly)` 는 *Restricted* 다.
  https://developers.google.com/workspace/drive/api/guides/api-specific-auth
- 🔎 "확인되지 않은 앱(unverified app)"은 *민감하거나 제한된 OAuth 범위를 요청하면서* 검증을 마치지 않은 앱이다. 이런 앱은 동의 화면 앞에 경고 화면이 뜨고 **신규 사용자 100명**으로 제한된다.
  https://support.google.com/cloud/answer/7454865
- 🔎 같은 문서: **코드가 요청하는 범위가 동의 화면 설정에 적은 범위와 다르면** 경고 화면이 뜬다. → 설치 안내에서 동의 화면(데이터 액세스)에 정확히 `openid`, `.../auth/userinfo.email`, `.../auth/drive.file` 만 넣도록 안내해야 한다. 민감 범위를 하나라도 넣어 두면 실제로 쓰지 않아도 검증 대상이 된다는 비공식 보고가 있다(🔎 커뮤니티 글).
- ❓ **브랜드 검증**: 범위 검증과 별개로, 앱 이름·로고를 동의 화면에 표시하려면 "브랜드 검증"이 필요할 수 있다. 검증 없이 게시했을 때 동의 화면에 이름이 어떻게 나오는지(이름 대신 도메인 등), 로고를 올리면 검증이 필요해지는지는 미확인. 로고는 올리지 않도록 안내하는 편이 안전하다.
- ❓ 교사가 학교 **Google Workspace for Education** 계정을 쓰면, 관리자 정책 때문에 "구성되지 않은 서드파티 앱"이 막힐 수 있다. 18세 미만 사용자는 기본으로 차단된다는 것은 🔎 확인(https://support.google.com/a/answer/13288950). 교사(성인) 계정이 기본으로 막히는지, 교육청별 설정이 어떤지는 미확인. → 설치 안내에 "개인 Gmail 계정 권장, 학교 계정이면 관리자에게 앱 허용 요청" 같은 분기를 둘 것.
- 참고(❓): Workspace 계정으로 Cloud 프로젝트를 만들면 사용자 유형을 "내부(Internal)"로 고를 수 있다. 내부 앱은 검증도, 7일 만료도 없다(🔎 위 7454865 문서에 "같은 도메인 내부 앱은 검증 불필요"). 다만 학교 조직 정책상 프로젝트를 만들 수 없는 경우가 많을 것으로 보인다(미확인).

## (b) 게시 상태가 "테스트 중(Testing)"이면 refresh token 이 7일 뒤 만료되나

결론: **그렇다(🔎).** 그래서 설치 안내는 반드시 **"앱 게시 → 프로덕션"** 단계를 넣어야 한다.

- 🔎 Google 지원 문서: 테스트 사용자의 승인은 동의 시점부터 **7일 뒤 만료**되고, 오프라인 액세스로 받은 refresh token 도 함께 만료된다. "앱 게시(Publish app)"를 눌러 프로덕션 상태가 되면 이 제한이 없어진다.
  https://support.google.com/cloud/answer/15549945 (검색 결과로만 확인)
- 🔎 커뮤니티: 프로덕션으로 바꾼 뒤에도 **테스트 중에 받은 기존 토큰은 계속 7일 제한을 받으므로 다시 동의(재로그인)** 해야 한다. 만료되면 토큰 엔드포인트가 `invalid_grant` 를 준다.
  https://groups.google.com/g/adwords-api/c/nmIY_WDNyTU/m/uc7Bk0PmBgAJ
- 테스트 중 상태에서는 테스트 사용자로 등록한 계정(최대 100명)만 로그인할 수 있다(🔎).
- 구현과의 연결: refresh token 이 만료·취소되면 `getGoogleAccessToken` 이 `invalid_grant` 를 받아 Registry 에 `needs_reconnect` 를 표시하고, `/api/me` 가 `drive.status = "reconnect_required"` 를 준다. 교사가 다시 로그인하면(`prompt=consent` 로 새 refresh token 발급) 풀린다. (테스트로 확인함)
- ❓ 그 밖의 refresh token 만료 사유(기억에 의존, 원문 미확인): 6개월 동안 사용하지 않음, 사용자가 계정 권한에서 앱 접근 해제, 계정·클라이언트당 발급 개수 한도(약 100개) 초과 시 오래된 것부터 무효화. 우리 앱은 매 로그인마다 새 refresh token 을 받으므로 한도에 걸릴 일은 거의 없지만, 6개월 미사용(방학 등) 후에는 다시 로그인이 필요할 수 있다.

## (c) Workers 무료 요금제에서 SQLite Durable Objects + WebSocket Hibernation 을 쓸 수 있나, 한도는

결론: **쓸 수 있다(✅).** 무료 요금제는 **SQLite 기반 DO만** 만들 수 있다(우리 wrangler.jsonc 는 `new_sqlite_classes` 사용). WebSocket Hibernation 을 무료 요금제에서 막는다는 문구는 없다(✅ 제한 문구 없음 확인, 무료에서 동작은 실제 배포로 확인 필요 ❓).

출처(✅):
- DO 요금: https://developers.cloudflare.com/durable-objects/platform/pricing/ (원본: `src/content/partials/durable-objects/durable-objects-pricing.mdx`, `do-plans-note.mdx`)
- DO 한도: https://developers.cloudflare.com/durable-objects/platform/limits/
- Workers 한도: https://developers.cloudflare.com/workers/platform/limits/
- Workers 요금: https://developers.cloudflare.com/workers/platform/pricing/
- 무료 요금제 DO 도입 공지(2025-04-07): https://developers.cloudflare.com/changelog/2025-04-07-durable-objects-free-tier/

| 항목 | Workers Free 한도 | 우리에게 주는 의미 |
|---|---|---|
| Worker 요청 | 100,000 / 일 (UTC 0시 초기화, 넘으면 오류 1027) | `/api/*`, `/auth/*` 만 Worker 를 거친다. **정적 자산 요청은 무료·무제한**(run_worker_first 를 API 경로로만 한정한 이유) |
| Worker CPU 시간 | **요청당 10 ms** | ⚠️ 태스크2: PIN 의 PBKDF2 반복 횟수를 크게 잡으면 10 ms 를 넘을 수 있다. 실제 측정해서 정할 것(❓ 측정 안 함). 네트워크 대기 시간은 CPU 시간에 안 들어감 |
| 서브요청(fetch) | 요청당 50 | Drive 백업·내보내기를 한 요청에서 많이 부르지 말 것 |
| DO 요청 | 100,000 / 일 | **RPC 메서드 호출 1회 = 요청 1회.** 웹소켓 연결 1회 = 1회, **들어오는 웹소켓 메시지는 20개당 1회**로 계산, 나가는 메시지는 무료. 알람 1회 = 1회 |
| DO 실행 시간 | 13,000 GB-s / 일 | DO 하나가 128 MB 로 계산 → 약 **28.2시간/일** 깨어 있을 수 있음(13,000 ÷ 0.128 ≈ 101,500초). Hibernation 가능한 유휴 상태는 과금 안 됨. `accept()` 로 받은 일반 웹소켓은 연결 내내 과금되므로 **반드시 `ctx.acceptWebSocket()`(Hibernation)** |
| SQLite 읽은 행 | 5,000,000 / 일 | |
| SQLite 쓴 행 | 100,000 / 일 | 삭제·`setAlarm()` 도 쓰기 1행. 30초 디바운스 백업 알람이 쓰기 1행씩 소모 |
| DO 저장 용량 | 계정 전체 5 GB | 첨부파일은 Drive 에 있으므로 충분 |
| DO 클래스 수 | 100 / 계정 | 우리는 2개 |
| 정적 자산 파일 | 버전당 20,000개 | |

- 무료 한도를 넘으면 그 종류의 작업이 오류로 실패한다(과금되지 않음). ✅
- 대략 계산(❓ 추정): 보드 1개에 50명 × 1시간 수업, 1인당 분당 2건 메시지 → 들어오는 메시지 6,000건 = DO 요청 300회 + 연결 50회. 하루 여러 수업을 해도 10만 한도에는 한참 못 미친다. 병목은 오히려 Worker 10 ms CPU 와 DO 쓴 행 수(카드·댓글·좋아요 1건당 여러 행) 쪽이다.

## (d) 비개발자 교사가 자기 Cloudflare 계정에 배포하는 가장 쉬운 방법

### 1안 (권장): "Deploy to Cloudflare" 버튼 ✅

출처: https://developers.cloudflare.com/workers/platform/deploy-buttons/ (원본 `src/content/docs/workers/platform/deploy-buttons.mdx`), Workers Builds 한도: https://developers.cloudflare.com/workers/ci-cd/builds/limits-and-pricing/

- 버튼 주소: `https://deploy.workers.cloudflare.com/?url=<공개 GitHub/GitLab 저장소 주소>`
- **GitHub 또는 GitLab 계정이 필요하다.** 버튼은 원본 저장소를 *교사의* GitHub/GitLab 계정에 복제하고, Workers Builds 로 빌드·배포한다. 원본 저장소는 **공개(public)** 여야 하고 github.com / gitlab.com 만 지원. ✅
- **Durable Objects 는 자동 준비 대상**에 들어 있다. ✅ (wrangler.jsonc 의 DO 바인딩·migrations 를 그대로 씀)
- **변수/시크릿 입력**: wrangler 설정의 `vars` 는 일반 변수로, `.dev.vars.example`(또는 `.env.example`)에 적은 이름은 시크릿으로 설정 화면에 나온다. `package.json` 의 `cloudflare.bindings.<이름>.description` 에 설명(마크다운 일부 지원)을 달 수 있다. ✅ → 이 저장소는 `.dev.vars.example` 에 `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` 을 두고, `package.json` 에 한국어 설명을 넣어 두었다.
  - ❓ 시크릿 칸을 **비워 둔 채로** 배포할 수 있는지는 미확인. 비울 수 없다면 교사가 Google OAuth 클라이언트를 *먼저* 만들어야 하는데, 이때 리디렉션 URI(`https://<Worker 이름>.<계정 하위도메인>.workers.dev/auth/google/callback`)를 미리 알아야 한다. Worker 이름은 설정 화면에서 정하고 하위도메인은 계정마다 정해져 있으므로 예측은 가능하다.
  - ❓ 버튼 설정 화면의 문구가 한국어로 나오는지 미확인.
- 빌드: `package.json` 의 `build`/`deploy` 스크립트를 자동으로 채워 준다(✅). 무료 요금제 Workers Builds: 월 3,000분, 동시 1개, 20분 제한(✅). 우리 빌드는 1분 이내.
- 이후 업데이트: 교사의 복제 저장소에 원본 변경을 반영(GitHub "Sync fork" 류)하면 자동 재배포. ❓ 버튼으로 만든 저장소가 fork 관계인지(= "Sync fork" 버튼이 있는지) 미확인. 아니면 업데이트 방법을 따로 안내해야 한다.
- 주의(✅ 문서): 대시보드에서 바꾼 변수는 다음 `wrangler deploy` 때 덮어써진다. 그래서 wrangler.jsonc 에 `"keep_vars": true` 를 넣었고, `GOOGLE_CLIENT_ID`·`OWNER_EMAIL` 을 `vars` 에 적지 않았다(대시보드/시크릿이 원본). 시크릿은 배포해도 유지된다.

### 2안: 교사 컴퓨터에서 Wrangler CLI

- Node.js 설치 → 압축 파일(릴리스) 내려받기 → `npm ci` → `npx wrangler login`(브라우저 로그인) → `npx wrangler secret put GOOGLE_CLIENT_SECRET` … → `npm run deploy`.
- GitHub 계정이 필요 없다. 대신 터미널을 써야 해서 비개발자에게 부담이 크다. Windows 학교 PC 는 설치 권한이 없을 수 있다(❓).

### 3안: 교사 GitHub 저장소 + GitHub Actions

- 교사가 저장소를 fork → Cloudflare API 토큰을 만들어 저장소 Secrets 에 등록 → Actions 가 `wrangler deploy`.
- 1안보다 단계가 많고 API 토큰 권한 설정이 어렵다. 1안이 막힐 때의 대안 정도.

### 4안 (검토만): 우리가 만든 설치 페이지에서 API 토큰으로 직접 업로드

- 교사가 Cloudflare API 토큰을 붙여 넣으면 페이지가 빌드된 번들과 정적 자산을 Cloudflare API 로 올리는 방식. GitHub 이 필요 없다.
- ❓ api.cloudflare.com 이 브라우저 CORS 를 허용하지 않는 것으로 알고 있어(미확인) 중계 서버가 필요할 수 있고, 토큰을 다루는 위험도 있다. 1차 범위에서는 권하지 않음.

### 어느 방법이든 필요한 Google 쪽 단계 (설치 안내 초안)

1. Google Cloud 콘솔에서 프로젝트 만들기.
2. OAuth 동의 화면(Google 인증 플랫폼): 사용자 유형 **외부**, 앱 이름, 지원 이메일. 범위는 `openid`, `userinfo.email`, `drive.file` 만. 로고는 올리지 않기(❓ 브랜드 검증 회피).
3. **대상(Audience) → 앱 게시 → 프로덕션** (7일 만료 회피, (b) 참고).
4. 사용자 인증 정보 → OAuth 클라이언트 ID → **웹 애플리케이션**, 승인된 리디렉션 URI: `https://<내 Worker 주소>/auth/google/callback`.
5. 클라이언트 ID/보안 비밀번호를 Worker 설정(버튼 화면 또는 대시보드 → Worker → 설정 → 변수 및 비밀)에 넣기.
6. 나눔보드 주소 → "Google 계정으로 로그인" → **처음 로그인한 계정이 소유자**. 동의 화면에서 "Google Drive 파일" 체크를 꼭 켜 두기(끄면 `/api/me` 가 `missing_scope`).
7. 프로덕션 + 비민감 범위만이면 "확인되지 않은 앱" 경고는 없어야 한다(🔎). 실제로 경고가 뜨는지 실제 계정으로 한 번 확인 필요(❓).

---

## 이 환경에서 열지 못한 곳

- `developers.google.com`, `support.google.com`, `developers.cloudflare.com`: 직접 접속 불가(DNS 차단). Cloudflare 는 GitHub 원본으로 대체 확인, Google 은 검색 요약만.
- 실제 Cloudflare 무료 계정 배포, 실제 Google OAuth 동의 화면 확인: 하지 않음.

---

## 추가 조사 (태스크6, 2026-11-14) — 위의 ❓ 일부 정리

- **설치 버튼의 시크릿 칸을 비워 둘 수 있나 → 없다(🔎 여러 사용자 보고, 공식 문서엔 언급 없음).** `.dev.vars.example` 에 적힌 이름은 모두 필수 입력으로 나오고 빈 칸이면 Deploy 를 막는다는 보고가 2026-05 ~ 10 사이 여러 건(cloudflare/workers-sdk 이슈 #14075, 다른 템플릿 저장소 PR 들). 그래서 `.dev.vars.example` 의 모든 줄을 주석으로 바꿔 **버튼 화면에서 아무것도 묻지 않게** 했고, 값은 설치 뒤 대시보드(Worker → Settings → Variables and Secrets → Add, Type=Secret → Deploy, ✅ 문서)에서 넣도록 안내한다.
- **버튼이 만드는 저장소는 fork 가 아니다(✅ 문서 그림 `dtw-user-flow.png`: 새 저장소, 커밋 1개 "source repo import" by cloudflare[bot]; 🔎 다른 프로젝트 이슈들도 "fork 링크·공통 이력 없음").** 따라서 "Sync fork" 로 업데이트할 수 없다. 안내의 업데이트 방법: 처음 한 번 원본을 Fork → Worker Settings → Build 에서 저장소 연결을 Fork 로 바꾸기(✅ "Connect an existing Worker" 문서) → 이후 Sync fork → Update branch 로 자동 재배포(❓ 실제로 확인 안 함).
- 버튼 설정 화면 항목(✅ 문서 그림): Set up your application / Configure repository / Git account / Repository name / Create private Git repository / Name your application / Worker name. 마지막 버튼 이름("Create and deploy")은 ❓.
- workers.dev 하위 도메인은 Workers & Pages 를 처음 열 때 자동 배정(🔎 검색 요약상 현 문서 문구). Workers Builds 기본 Node 24(✅ build-image 문서).
- Google: 2025-06 부터 클라이언트 보안 비밀번호는 **만들 때 한 번만** 보이고 이후 가려짐, 6개월 쓰지 않은 OAuth 클라이언트는 자동 삭제(🔎 Google 개발자 블로그 2025-04-28 검색 요약). 브랜드 검증 없으면 동의 화면에 앱 이름 대신 도메인이 보일 수 있음(🔎).
- 학교 Workspace: 관리자가 서드파티 앱을 막으면 `admin_policy_enforced` / "관리자 검토 필요" 화면(🔎). 교사 계정이 Cloud 프로젝트를 만들 수 있는지는 학교마다 다름(❓). 안내는 "개인 Gmail 추천, 학교 드라이브가 필요하면 프로젝트는 개인 계정으로 만들고 첫 로그인만 학교 계정" 으로 정리.
- **Google Drive API 사용 설정이 필요**하다(토큰 발급은 되지만 Drive 호출이 403 `accessNotConfigured`). 안내에 단계로 넣고, `/api/setup/drive-check` 로 점검한다.
