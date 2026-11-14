# 진짜 계정으로만 확인할 수 있는 것 (VERIFY-LIVE)

자동 시험(`npm test`, `npm run e2e`, `npm run e2e:load`)은 가짜 Google 과 로컬 `wrangler dev` 에서 돈다.
아래는 **실제 Cloudflare 무료 계정 + 실제 Google 계정**이 있어야 확인되는 것들이다. 출시 전에 한 번씩 확인하고 결과를 이 파일에 적는다.
(근거: docs/DESIGN.md, docs/RESEARCH-deploy.md 의 ❓·🔎 항목, 태스크 7 점검)

| # | 확인할 것 | 정확한 확인 방법 | 안 되면 |
|---|---|---|---|
| 1 | **설치 버튼이 비밀 값을 묻지 않고 배포됨** | 새 Cloudflare 무료 계정(카드 없음)으로 README 의 Deploy 버튼 → 저장소 이름·Worker 이름만 넣고 배포가 끝나는지. Durable Object 2개(Registry, Board)가 만들어지는지(대시보드 → Worker → 바인딩) | 비밀 칸이 나오면 `.dev.vars.example` 의 줄이 주석인지 확인. DO 가 안 만들어지면 `wrangler.jsonc` 의 `new_sqlite_classes` 와 무료 요금제 DO 사용 여부 확인 |
| 2 | **Cloudflare·Google 콘솔 화면 이름이 안내와 같음** | `/setup` 안내를 처음부터 따라 하며 단추·메뉴 이름(Workers & Pages, 설정 → 변수 및 비밀, Google 인증 플랫폼 → 브랜딩·대상·데이터 액세스·클라이언트, API 및 서비스 → 라이브러리)이 화면과 같은지. 한국어·영어 화면 둘 다 | `web/setup/steps.tsx`, `web/setup/help.tsx` 의 문구를 실제 이름으로 고친다 |
| 3 | **"확인되지 않은 앱" 경고가 없음** (openid·email·drive.file 만, 프로덕션 게시) | 앱을 프로덕션으로 게시한 뒤 처음 보는 Google 계정으로 로그인. 경고 화면 없이 동의 화면이 나오는지, 앱 이름 대신 도메인이 보이는지 기록 | 경고가 나오면 동의 화면 **데이터 액세스**에 다른 범위가 들어갔는지 확인. 그래도 나오면 안내에 "고급 → 이동" 단계를 그림과 함께 넣는다 |
| 4 | **동의 화면에서 드라이브 체크를 끄면** | 로그인 때 "Google 드라이브 파일" 체크를 끈다 → 선생님 화면 위 빨간 띠, `/setup` 점검의 "드라이브 권한이 빠졌어요" | `/api/me` 의 `drive.status` 가 `missing_scope` 인지 확인 (`src/worker/auth/routes.ts`) |
| 5 | **Drive API 를 안 켰을 때 메시지** | Drive API 를 끈 프로젝트로 로그인 → `/setup` 점검이 "Google Drive API가 꺼져 있어요", 보드 백업 배지가 "백업 실패 · Drive API 켜기" 로 `/setup#help-api` 연결. Google 이 주는 reason 이 정말 `accessNotConfigured`(또는 `SERVICE_DISABLED`)인지 Worker 로그로 확인 | reason 이 다르면 `src/worker/drive/client.ts` 의 `API_DISABLED_REASONS` 에 추가 |
| 6 | **브라우저 → Drive 직접 PUT (CORS)** | 휴대폰·PC 크롬에서 사진을 올릴 때 개발자 도구 Network 에 `www.googleapis.com/upload/drive/v3/files?...upload_id=` PUT 이 200 인지(직접), 아니면 `/api/boards/…/uploads/…/proxy` 로 갔는지(대체 경로) | 직접 PUT 이 늘 실패해도 프록시로 올라가므로 동작은 된다. 다만 프록시는 Worker 요청 1건 + 요청 본문 100MB 제한(무료)이 붙는다. 세션을 만들 때 `origin` 헤더(`src/worker/drive/uploads.ts` 의 `pageOrigin`)가 실제 주소인지 확인 |
| 7 | **완료 확인의 세션 상태 조회** | 사진 올린 뒤 `/complete` 가 200 인지. Worker 로그에 `upload verify failed` 가 없는지 | 실제 Drive 가 `Content-Range: bytes */N` PUT 에 200/201 + 파일 JSON 을 안 주면 `completeUpload` 를 `driveFileId` 확인 방식으로 바꿔야 한다 |
| 8 | **refresh token 유지** (7일 만료 없음) | 프로덕션 게시 후 로그인 → 8일 뒤 사진 올리기·백업이 되는지 | `/setup` 점검의 "드라이브 연결이 끊겼어요" → 앱이 아직 테스트 중인지 확인, 다시 로그인 |
| 9 | **WebSocket Hibernation 과 무료 한도** | 한 교시 수업(30명) 뒤 대시보드 → Workers & Pages → 나눔보드 → 지표(Metrics)·Durable Objects 사용량에서 요청 수, DO 요청(웹소켓 메시지 20:1 포함), 행 쓰기, 실행 시간(GB-초)을 README 의 추정(교시당 Worker ≈1,230, DO ≈1,620, 행 쓰기 ≈1,200, ≈690 GB-초)과 비교. `ping`/`pong` 자동 응답이 DO 요청으로 세지는지 | 크게 넘으면: 학생 화면의 ping 간격을 늘리거나(웹 `web/lib/realtime.ts`), 백업 간격(`BACKUP_DELAY_MS`)을 늘리고, 사진 보기를 서명된 Drive id 토큰으로 바꿔 DO 조회를 없앤다 |
| 10 | **workers.dev 에서 Cache API** | 같은 사진 주소를 두 번 열고 응답 헤더 `x-cache` 를 본다 (workers.dev 에서는 저장이 안 되어 늘 `miss` 일 것으로 예상) | 예상대로면 그대로 둔다 (브라우저 캐시가 1년 불변으로 받는다). 사용자 지정 도메인을 붙이면 `hit` 이 나와야 한다 |
| 11 | **정적 화면 보안 헤더(`_headers`)** | 배포된 주소에서 `curl -I https://…/b/ABCDEF` 에 `content-security-policy`, `x-frame-options` 가 붙는지. `/assets/*.js` 에 `cache-control: public, max-age=31536000, immutable` | 안 붙으면 Workers Static Assets 의 `_headers` 지원을 확인하고, 안 되면 Worker 에서 HTML 응답에 헤더를 붙인다 |
| 12 | **iOS Safari·안드로이드 카메라·클립보드** | 아이폰 Safari 에서 **📷 사진 찍기**(카메라가 바로 뜨는지), HEIC 사진 고르기(JPEG/WebP 로 줄여 올라가는지), 맥/PC 에서 사진 붙여넣기(Ctrl+V)와 끌어 놓기. 안드로이드 크롬도 같게 | HEIC 가 안 줄어들면 `web/lib/upload.ts` 의 압축 경로 확인. 붙여넣기는 `#composer-form` 의 `onPaste` |
| 13 | **QR 이 실제 휴대폰 카메라로 읽힘** | 교실 프로젝터 화면의 QR 을 아이폰·안드로이드 기본 카메라로 찍어 `/b/코드` 가 열리는지 | `web/teacher/qr.ts` 의 오류 정정 단계를 올린다 |
| 14 | **실제 인쇄** | **PIN 쪽지 인쇄**·포트폴리오 인쇄를 A4 프린터와 "PDF 로 저장"으로. 쪽지가 잘리지 않는지, 다크 모드에서 인쇄해도 흰 바탕인지 | `web/teacher/teacher.css` 의 `@media print` |
| 15 | **학교 Google Workspace 계정** | 학교 계정으로 로그인했을 때 `admin_policy_enforced` 등 관리자 차단이 나오는지 | 안내대로 개인 Gmail 로 프로젝트·주인을 만들도록 |
| 16 | **업데이트 경로** | 버튼으로 만든 저장소를 Fork 연결로 바꾸고 Sync fork 했을 때 자동 재배포되는지(RESEARCH ❓) | 설치 안내의 "업데이트하는 법" 을 실제 순서로 고친다 |
| 17 | **주인 먼저 차지하기** | Google 값을 넣은 직후 다른 계정으로 먼저 로그인하면 그 계정이 주인이 되는지, `OWNER_EMAIL` 을 넣으면 선생님 계정으로 주인이 넘어오는지 | 설계상 "처음 로그인한 계정이 주인". 위험을 줄이려면 안내에서 `OWNER_EMAIL` 넣기를 권한다 |
| 18 | **Workers Logs 에 남는 주소** | 대시보드 → Worker → 로그에서 웹소켓 주소의 `?st=`(학생 토큰), 파일 주소의 `?t=`(12시간 파일 토큰)가 보이는지 | 선생님 계정 안에만 남지만, 원하면 `wrangler.jsonc` 의 `observability` 를 끈다 |
