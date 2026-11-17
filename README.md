# 나눔보드

수업 시간에 학생들과 함께 쓰는 **실시간 게시판**이에요. 글·사진·파일·댓글·좋아요가 새로 고침 없이 바로 보이고, 학생은 로그인 없이 입장 코드(또는 QR)로 들어와요.

- 선생님 **한 분이 자기 계정에 한 벌** 설치해서 쓰는 방식이에요. 만든 사람(이 저장소)에게는 아무 정보도 가지 않아요.
- 보드 종류: 개인별·모둠별·주제별 칸, 학생당 1카드 또는 여러 장, 명단 입장(학번 + PIN 4자리) 또는 자유 입장(닉네임만).
- 수업 도구: 승인 후 게시, 카드 숨기기, 보드 잠금, 익명 모드, 공지, 선생님 피드백(본인만 보임), 아직 안 쓴 학생 보기, 프로젝터 화면, PIN 쪽지 인쇄, 학생별 포트폴리오, 구글 시트로 내보내기, 보관함.
- 선생님이 쓰는 법은 [docs/사용-안내.md](docs/사용-안내.md) 에 있어요.

## 설치하기

**[친절한 설치 안내 보기](https://sanchucksatgat.github.io/naum-board/)** — 한 단계씩 따라 하면 돼요. (약 40분, 컴퓨터 권장)

1. GitHub, Cloudflare 무료 가입
2. 아래 버튼으로 설치 → 내 나눔보드 주소(`https://nanumboard.○○.workers.dev`)가 생겨요
3. Google Cloud에서 프로젝트를 만들고 **Google Drive API 켜기**, 로그인용 출입증(OAuth 클라이언트) 만들기, 앱을 **프로덕션으로 게시**
4. Cloudflare의 Worker 설정 → 변수 및 비밀에 `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` 넣기
5. 내 나눔보드에 Google로 처음 로그인 → **그 계정이 주인**이 돼요. 이어서 `내 주소/setup` 의 **설치 점검**이 모두 초록색인지 확인!

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/sanchucksatgat/naum-board)

> 설치 버튼 화면에서는 Google 값을 묻지 않아요. 설치가 끝난 다음 안내에 따라 넣으면 돼요.
>
> ⚠️ Google 값을 넣은 뒤에는 **바로 선생님 계정으로 첫 로그인**을 해 주세요. 주소를 아는 다른 사람이 먼저 로그인하면 그 사람이 주인이 돼요.
> 걱정되면 변수 `OWNER_EMAIL` 에 선생님 이메일을 넣어 두세요 (그 계정만 주인이 될 수 있어요).

설치한 나눔보드에서도 `https://내주소/setup` 을 열면 같은 안내가 나오고, 마지막 단계에서 Google 설정·주인 계정·드라이브 권한·Drive API 까지 실제로 점검해 줘요.

## 데이터는 어디에 저장되나요?

| 무엇 | 어디에 |
|---|---|
| 글·댓글·좋아요·공지·명단(학번·이름·모둠·닉네임) | 선생님 Cloudflare 계정의 Durable Object (SQLite) |
| 학생 PIN | 저장 안 함. 서버 비밀키로 만든 해시만 보관. 처음 받은 초기 PIN 은 학생이 나만의 PIN 을 정하면 지워져요 |
| 사진·파일 | 선생님 Google 드라이브 `나눔보드/{보드 이름} ({코드})/첨부/` (공개 공유하지 않음, 언제나 나눔보드를 거쳐서만 보임) |
| 글 백업 | 같은 폴더의 `게시글 백업.json` (바뀐 뒤 30초마다) |
| 시트 내보내기 | 같은 폴더의 구글 시트 |
| 학생 기기 | 입장 토큰과 기기 표시만 (브라우저 localStorage) |

나눔보드 앱은 `drive.file` 권한만 받아서 **자기가 만든 파일만** 볼 수 있어요. 선생님 드라이브의 다른 파일은 볼 수 없어요.
보드를 지워도 드라이브의 사진·백업 파일은 남아요.

## 무료로 쓸 수 있나요?

네. Cloudflare Workers 무료 요금제와 Google 무료 계정으로 충분하고 카드 등록도 필요 없어요. 무료 한도는 하루 단위(한국 시간 오전 9시에 초기화)예요.

| 무료 한도 (하루) | 하루 6교시 × 30명 + 50명 연수 1번 쓰면 (대략) |
|---|---|
| Worker 요청 10만 번 | 약 1만 번 (10%) — 대부분 학생들이 사진을 볼 때 |
| Durable Object 요청 10만 번 | 약 1만 3천 번 (13%) |
| 저장 행 쓰기 10만 개 | 약 1만 개 (10%) |
| Durable Object 실행 시간 13,000 GB-초 | 약 5,000 GB-초 (40%, 가장 넉넉하지 않은 항목) |

한도를 넘으면 그날은 오류가 나고(요금이 나가지는 않아요), 다음 날 다시 돼요. 화면(HTML·그림 파일)을 받는 것은 한도에 들어가지 않아요.
계산 근거는 아래 개발자용의 "무료 한도 계산" 을 보세요.

## 업데이트

설치 안내 페이지 아래쪽의 **업데이트하는 법**을 보세요.

---

## 개발자용

Node.js 22 이상.

```bash
npm ci                           # 의존성 설치 (npm 10 에서 동작 확인)
npm run typecheck                # 서버·화면·시험 타입 검사
npm test                         # Workers 런타임(workerd) 안의 서버 시험 + 화면 순수 로직 시험
npm run build                    # 화면 빌드(dist/web) + 배포 번들 확인(dist/worker, 실제 배포는 안 함)
npm run dev                      # 화면 빌드 + wrangler dev (http://localhost:8787, 진짜 Google 설정 필요)
npm run build:guide              # 설치 안내만 정적 페이지로 → dist/guide/
```

- 새 패키지를 넣을 때: 이 환경의 npm 10 에서 `npm install <패키지>` 가 멈추는 일이 있었어요. 그럴 땐 `npx npm@11 install <패키지>` 뒤에 `npm rebuild esbuild workerd`.
- 로컬에서 진짜 Google 로그인까지 시험하려면 `cp .dev.vars.example .dev.vars` 후 주석(#)을 풀고 값을 채우세요 (`.dev.vars` 는 git 에 안 올라가요).

### 브라우저·부하 시험 (가짜 Google)

진짜 Google·Cloudflare 계정 없이 전체 흐름을 시험하는 서버가 있어요. `test/e2e/worker.ts` 가 실제 Worker 를 감싸고
시험용 경로(`/__test/login`, `/__test/drive`)와 메모리 속 가짜 Google 드라이브를 더해요. 이 파일은 `test/e2e/wrangler.jsonc` 에서만 쓰여서
배포 번들(`dist/worker/index.js`)에는 들어가지 않아요 (`npm run build` 뒤 `grep __test dist/worker/index.js` 가 비어 있어야 해요).

```bash
npm run e2e:serve   # 빌드 + 깨끗한 상태로 시험 서버 http://localhost:8791 (교사로 들어가기: /__test/login)
npm run e2e         # 위 서버 + Playwright 시나리오 (교사 화면으로 반·보드 3개 만들기 → 학생 휴대폰·데스크톱, 3~4분)
npm run e2e:load    # 위 서버 + 학생 50명·교사 1명 실제 웹소켓 부하 시험
```

- Playwright 는 이 저장소 의존성이 아니에요. 시험하는 컴퓨터에 전역으로 설치된 것을 `require("playwright")` 로 써요 (Chromium 포함).
- 스크린숏은 `OUT=폴더` (기본 `./e2e-shots`), 빌드 생략은 `SKIP_BUILD=1`.

### 무료 한도 계산 (근거)

`npm run e2e:load` 측정(학생 50명, 같은 보드): 접속 51명 0.3초, 변경분 지연 p50 9ms·p95 14ms, 카드 300장 스냅숏 약 145KB.
한 교시(30명, 45분, 1인당 사진 1장·글 1~2개·댓글 5·좋아요 10)를 이렇게 셌어요.

- Worker 요청 ≈ 1,230: 입장·접속·재접속 120 + 사진 올리기 90 + **사진 보기 30장 × 30명 ≈ 900**(브라우저가 한 번 받은 사진은 다시 받지 않음) + 교사 화면 120
- DO 요청 ≈ 1,620: 사진 보기 960 + 접속(Registry+Board) 120 + 업로드 120 + 웹소켓 메시지 (쓰기 600 + 연결 유지 ping 약 2,000) ÷ 20 ≈ 130 + 백업 알람(30초마다, 90번 × 2) 180 + 그 밖 110
- 저장 행 쓰기 ≈ 1,200: 카드 30×2, 첨부 30×2, 댓글 150×2, 좋아요 300, 접속 기록 30, 백업 알람 90번 × 약 5행
- 실행 시간: 수업 중 보드 DO 와 Registry DO 가 계속 깨어 있다고 보고 128MB × 2,700초 × 2 ≈ 690 GB-초

하루 = 6교시 + 50명 1시간(사진 보기가 50×50 으로 늘어 교시의 약 2.5배): Worker ≈ 10.5천, DO ≈ 13천, 행 쓰기 ≈ 1만, 실행 시간 ≈ 5천 GB-초.
실제 무료 요금제에서 hibernation·과금이 이대로인지는 [docs/VERIFY-LIVE.md](docs/VERIFY-LIVE.md) 에서 확인할 항목이에요.

### 문서

- 설계: [docs/DESIGN.md](docs/DESIGN.md), 실시간 프로토콜: [docs/PROTOCOL.md](docs/PROTOCOL.md), 배포 조사: [docs/RESEARCH-deploy.md](docs/RESEARCH-deploy.md)
- 진짜 계정으로만 확인할 수 있는 것: [docs/VERIFY-LIVE.md](docs/VERIFY-LIVE.md)
- 원본 저장소 주소는 `web/setup/config.ts` 의 `SOURCE_REPO_URL` 과 이 README 의 버튼·안내 링크 두 곳에 있어요. 저장소를 옮기면 함께 바꿔 주세요.
- 설치 안내 공개 페이지는 `.github/workflows/guide-pages.yml` 이 GitHub Pages 로 올려요. 저장소 설정 → Pages → Source 를 **GitHub Actions** 로 바꾸고, 저장소 변수 `PUBLISH_GUIDE` 를 `true` 로 만들어야 동작해요(선생님들이 설치하며 생기는 복사본에서는 돌지 않게 하려는 장치).
