# 나눔보드 설계 기준서

수업·연수용 실시간 게시 보드. 기존 "탭보드"(Apps Script 기반)의 후속작이다.
이 문서는 모든 작업자가 따르는 계약이다. 바꿔야 하면 지휘관에게 먼저 알린다.

## 1. 원칙

- **자가설치형**: 교사 한 명이 자기 Cloudflare 계정에 한 벌을 설치한다. 인스턴스 하나 = 교사(소유자) 한 명.
- **빠름이 최우선**: 글·댓글·좋아요는 웹소켓으로 즉시 반영. 화면 전체 재조회 금지.
- **업로드 자료는 교사의 Google Drive에**: 첨부파일은 Drive가 원본. 글(텍스트)은 Durable Object가 작업본, Drive에 자동 백업.
- **학생은 로그인 없음**: 입장코드 + (학번·PIN | 닉네임).
- **무료 요금제에서 동작**: Cloudflare Workers Free + SQLite 기반 Durable Objects. 유료 전용 기능(R2, KV 필수 의존 등) 금지.
- 한 보드 동시 접속 50명 기준.
- UI 문구는 전부 한국어, 초등~교사 모두 읽기 쉬운 말.

## 2. 구성

```
브라우저(정적 프런트) ──HTTP/WS──> Worker ──> Registry DO (인스턴스당 1개)
                                        └──> Board DO (보드당 1개, WebSocket Hibernation)
브라우저 ──(업로드 세션 URL로 직접 PUT)──> Google Drive
Worker ──(교사 refresh token)──> Google Drive API
```

- Worker 하나가 정적 자산(프런트)과 API를 함께 서빙한다 (Workers Static Assets).
- 언어: TypeScript. 서버 의존성 최소(라우터는 Hono 허용). 프런트: Vite + Preact + TypeScript.
- 테스트: vitest + @cloudflare/vitest-pool-workers. Google API는 테스트에서 가짜(fetch mock)로 대체.

### 디렉터리

```
src/worker/index.ts        라우팅 진입점
src/worker/auth/           교사 Google 로그인, 세션 (태스크1)
src/worker/registry/       Registry DO (태스크1 골격, 태스크2 확장)
src/worker/board/          Board DO, 실시간 프로토콜 (태스크2)
src/worker/drive/          Drive 클라이언트, 업로드, 백업, 내보내기 (태스크3)
src/shared/                서버·프런트 공용 타입 (프로토콜 타입 포함)
web/                       프런트 (web/student, web/teacher, web/setup, web/lib)
test/                      테스트
docs/                      문서
```

## 3. 설정값 (Worker 변수/시크릿)

| 이름 | 종류 | 설명 |
|---|---|---|
| GOOGLE_CLIENT_ID | var | 교사가 만든 OAuth 클라이언트 ID |
| GOOGLE_CLIENT_SECRET | secret | 위 클라이언트의 시크릿 |
| SESSION_SECRET | secret | 세션·토큰 서명 키(HMAC). 없으면 최초 실행 시 Registry DO가 생성·보관 |
| OWNER_EMAIL | var(선택) | 지정하면 이 계정만 소유자가 될 수 있음 |

## 4. 인증

### 교사
- Google OAuth 2.0 인가 코드 흐름. scope: `openid email https://www.googleapis.com/auth/drive.file` (앱이 만든 파일만 접근).
- `access_type=offline`, `prompt=consent`로 refresh token 확보, Registry DO에 저장.
- 최초 로그인한 Google 계정(`sub`)이 소유자가 된다. 이후 다른 계정 로그인은 거부. OWNER_EMAIL이 있으면 그 계정만 허용.
- 교사 세션: HttpOnly·Secure·SameSite=Lax 쿠키, HMAC 서명, 30일.
- 경로: `GET /auth/google`, `GET /auth/google/callback`, `POST /auth/logout`, `GET /api/me`.

### 학생
- 보드마다 입장코드(영숫자 6자, 헷갈리는 글자 제외). 주소 `/b/{코드}` 또는 QR.
- **명단 모드**: 학번 + PIN 4자리. PIN은 PBKDF2 해시 저장. 실패 5회 → 해당 학번 5분 잠금, IP당 분당 시도 제한.
- **자유 입장 모드**: 닉네임만. 기기별 무작위 토큰으로 본인 카드 식별.
- 학생 토큰: HMAC 서명, 보드 범위 한정. localStorage 보관.

## 5. 데이터 모델 (요지)

Registry DO (SQLite):
- `owner(sub, email, refresh_token, drive_root_id)`
- `boards(id, code, title, type, column_mode, entry_mode, archived, created_at, drive_folder_id)`
- `students(id, class_id, number, name, pin_hash, pin_failed, locked_until)`, `classes(id, name)` — 명단은 반 단위로 관리하고 보드에 연결. 기존 탭보드의 명단 의미(학번·이름·PIN·닉네임)를 따른다.

Board DO (SQLite):
- `settings` — 보드 설정 사본: 유형(학생당 1카드 | 누적), 열 구성(개인별 | 모둠별 | 주제별), 입장 모드(명단 | 자유), 승인 후 게시, 잠금, 익명 모드, 좋아요·댓글 허용.
- `columns(id, title, kind, owner_ref, position)`
- `posts(id, column_id, author_ref, author_name, title, body, link, status[visible|pending|hidden], created_at, updated_at)`
- `attachments(id, post_id, drive_file_id, name, mime, size, kind[image|file], width, height)`
- `comments(id, post_id, author_ref, author_name, body, created_at)`
- `likes(post_id, author_ref)`
- `feedback(post_id, body, updated_at)` — 교사 피드백(해당 학생과 교사만 봄)
- `notices(id, title, body, created_at)`
- `members(ref, number, name, nickname, last_seen)`

## 6. 실시간 프로토콜

- `GET /api/boards/{code}/ws` (학생 토큰 또는 교사 쿠키) → Board DO WebSocket.
- 접속 직후 서버가 `snapshot`(역할에 맞게 걸러진 전체 상태) 전송. 이후는 변경분(`post.upsert`, `post.remove`, `comment.add`, `comment.remove`, `like.set`, `notice.upsert`, `notice.remove`, `settings.update`, `presence`)만 전송.
- 쓰기는 웹소켓 메시지로 보내고 서버가 권한 검증 후 방송. 클라이언트는 낙관적 반영 후 서버 확정으로 교정.
- **가시성 규칙은 서버가 적용**: 익명 모드면 학생에게 타인 실명·학번을 보내지 않는다. pending/hidden 카드는 작성자와 교사에게만. 피드백은 당사자와 교사에게만.
- 재접속 시 지수 백오프, 재접속 후 snapshot으로 재동기화.
- 메시지 타입 정의는 `src/shared/protocol.ts`가 단일 출처. 상세는 `docs/PROTOCOL.md`(태스크2 작성).

## 7. Drive

- 폴더: `나눔보드/{보드 제목} ({코드})/` 아래 `첨부/`, `게시글 백업.json`, 내보낸 시트.
- **업로드**: 클라이언트가 `POST /api/boards/{code}/uploads`(이름·크기·MIME) → Worker가 권한·크기·잠금 확인 후 Drive resumable 업로드 세션을 만들어 세션 URL 반환 → 브라우저가 Drive로 직접 PUT → 완료 후 클라이언트가 fileId를 서버에 보고 → 서버가 Drive에서 파일이 해당 보드 폴더에 있는지 확인 후 첨부로 등록.
  - 브라우저 직접 PUT이 CORS로 불가하면 Worker 스트리밍 프록시로 대체(같은 API 모양 유지). 어느 쪽인지 태스크3이 실제 확인.
- 이미지는 업로드 전 브라우저에서 긴 변 1600px·WebP/JPEG로 압축. 파일 크기 상한 기본 25MB(설정 가능).
- **보기**: `GET /api/files/{attachmentId}?t={서명토큰}` — Worker가 Drive에서 가져와 Cache API로 캐시. Drive 파일은 공개 공유하지 않는다.
- **백업**: Board DO가 변경 후 30초 디바운스 알람으로 `게시글 백업.json` 갱신. 실패는 재시도하고 교사 화면에 상태 표시.
- **시트 내보내기**: CSV를 Google 시트로 변환 업로드(drive.file 범위 내).

## 8. 기능 범위 (1차)

유지: 카드(글·사진·첨부·링크), 댓글, 좋아요, 교사 피드백, 공지, 닉네임 변경, 개인별·모둠별 열, 보드 유형 2종, 명단 CSV 가져오기/예시, PIN 등록·초기화·PIN 쪽지 인쇄, QR·링크 공유, 프로젝터 보기, 학생 포트폴리오, 시트 내보내기, 보관함, 보드 이름 변경·설정, 학생용 휴대폰 화면.

신규: 자유 입장 모드, 주제별 열, 승인 후 게시·카드 숨김, 보드 잠금, 미제출자 표시(명단 모드), 익명 모드.

삭제: 교사 관리키·관리 주소·복구 안내, 서버 연결·업데이트 안내, 20초 폴링·새로고침 버튼, 브라우저 ZIP 다운로드("드라이브 폴더 열기"로 대체), 데모 모드(가짜 서버).

2차(지금 만들지 않음): 개인 QR 쪽지, 링크 미리보기, 카드 끌어 옮기기, 발표 모드, 보드 복제, 탭보드 데이터 가져오기.

## 9. 작업 규칙

- 자기 태스크 디렉터리 밖의 파일을 고쳐야 하면 최소한으로, 보고서에 명시.
- git commit/push 하지 않는다(지휘관이 한다). 시크릿·개인 이메일을 코드나 문서에 넣지 않는다.
- 끝낼 때: `npm run typecheck`와 `npm test` 통과 결과를 실제 출력과 함께 보고. 확인하지 못한 것은 "미확인"으로 구분해 적는다.

## 10. 태스크 2 ↔ 3 경계 계약 (병렬 작업용)

PIN 저장 변경: 무료 요금제 CPU 한도(요청당 10ms) 때문에 PBKDF2 대신 `HMAC-SHA256(서버 비밀키, 학생별 salt + PIN)`을 쓴다. 4자리 PIN의 안전은 해시 강도가 아니라 시도 횟수 제한이 책임진다.

### 태스크 2가 제공 (src/worker/board, src/worker/registry)
- `authenticateBoardActor(request, env, code): Promise<BoardActor | null>` (`src/worker/board/actor.ts`)
  `BoardActor = { role: "teacher" | "student"; ref: string; name: string; boardId: string; code: string }`
- Registry RPC: `resolveBoardByCode(code): { id, code, title, archived } | null`
- Board DO RPC:
  - `getUploadPolicy(actor: BoardActor): { ok: true; maxBytes: number } | { ok: false; reason: string }` — 잠금·보관·권한 확인
  - `getAttachment(attachmentId): { driveFileId, name, mime, size, kind } | null`
  - `getDriveState(): { folderId?: string; attachFolderId?: string; backupFileId?: string; title: string; code: string }`
  - `setDriveState(patch): void`
  - `exportRows(): { header: string[]; rows: string[][] }` — 시트 내보내기용
- 첨부 등록: 클라이언트가 `post.save` 메시지에 태스크 3이 발급한 **업로드 확인 토큰**(purpose `"upload"`, payload `UploadedFile`)을 넣어 보낸다. Board DO는 `verifyToken`으로 검증하고 boardId·actor ref 일치를 확인한 뒤 attachments에 저장한다.
  `UploadedFile = { boardId, by: string /*actor ref*/, driveFileId, name, mime, size, kind: "image" | "file", width?, height? }` — `src/shared/files.ts`에 정의(태스크 3이 파일 생성, 태스크 2는 import).
- snapshot에 **파일 보기 토큰**(purpose `"file"`, payload `{ boardId }`, 12시간)을 actor마다 하나 넣어 준다.
- 백업: 변경 30초 뒤 알람에서 `writeBoardBackup` 호출. 실패 시 재시도(지수 백오프)하고 상태를 교사 snapshot에 노출.

### 태스크 3이 제공 (src/worker/drive, export는 `src/worker/drive/index.ts`)
- `ensureBoardFolders(env, boardId): Promise<{ folderId: string; attachFolderId: string }>` — Board의 get/setDriveState 사용, 없으면 Drive에 생성
- `writeBoardBackup(env, boardId, content: object): Promise<void>` — `게시글 백업.json` 생성/갱신
- `renameBoardFolder(env, boardId, title): Promise<void>`
- 라우트(태스크 3 소유):
  - `POST /api/boards/:code/uploads` → `{ uploadUrl, method, headers, uploadId }` (직접 PUT 또는 프록시 주소)
  - `POST /api/boards/:code/uploads/:uploadId/complete` → `{ token /*업로드 확인 토큰*/, file: UploadedFile }`
  - `GET /api/files/:boardId/:attachmentId?t=` — 파일 보기 토큰 검증 → 캐시 → `Board.getAttachment` → Drive
  - `POST /api/boards/:code/export` (교사) → `{ url }` 구글 시트 링크
  - `GET /api/boards/:code/drive` (교사) → `{ folderUrl, backup: { status, lastAt } }`
- 병렬 작업 중 상대 구현이 아직 없으면 위 시그니처대로 임시 구현/모의 객체로 테스트하고, 통합은 지휘관이 맞춘다.
