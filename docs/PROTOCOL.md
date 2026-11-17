# 나눔보드 실시간 프로토콜·보드 API (태스크2)

타입의 단일 출처는 `src/shared/protocol.ts` (업로드·파일 타입은 `src/shared/files.ts`, 태스크3).
이 문서는 그 타입이 **무슨 뜻이고 언제 오가는지**를 설명한다. 둘이 다르면 `protocol.ts` 가 맞다.

---

## 1. 접속 흐름

```
학생(명단)  GET  /api/boards/{code}            → 공개 정보 (제목, 입장 방식, 잠김/보관)
            POST /api/boards/{code}/login      → { status:"ok", token } | { status:"pin_setup", setupToken }
            POST /api/boards/{code}/pin        → { token }          (처음 입장: 나만의 PIN)
학생(자유)  POST /api/boards/{code}/join       → { token }          (닉네임 + 기기 토큰)
            WS   /api/boards/{code}/ws?st={token}
교사        WS   /api/boards/{code}/ws         (세션 쿠키, 같은 출처에서만)
```

- 학생 토큰은 **보드 하나에만** 유효(HMAC 서명, 30일, purpose `"student"`). `localStorage` 에 보드 코드별로 보관.
- 웹소켓은 헤더를 못 붙이므로 쿼리 `?st=` 로 보낸다. REST 는 `Authorization: Bearer {token}`.
- 학생 토큰이 있으면 그것을, 없으면 교사 쿠키를 본다(교사가 학생 화면을 시험해 볼 수 있음).
- 연결되면 서버가 곧바로 `snapshot` 을 보낸다. 이후에는 변경분만 온다.

### 1.1 명단 입장 (학번 + PIN)

1. 교사가 명단을 넣을 때 PIN 칸이 비면 서버가 **무작위 4자리 초기 PIN** 을 만든다(교사 화면·PIN 쪽지에 보임).
2. 학생이 학번 + 초기 PIN 으로 `login` → `pin_setup` + `setupToken`(10분).
3. `pin` 에 `{ setupToken, newPin }` → 나만의 PIN 저장(초기 PIN·`1111`·`0000`·`1234` 금지) → 학생 토큰.
   이때부터 초기 PIN 은 지워지고, 서버에는 `HMAC-SHA256(PIN 전용 키, 학생별 salt + ":" + PIN)` 만 남는다.
4. 다음부터는 학번 + 나만의 PIN → `{ status:"ok", token }`.

시도 제한: 학번별 5회 실패 → 5분 잠금(`student_locked`, 맞는 PIN 도 거부). IP 당 1분에 실패 30회 → `too_many_attempts`
(학교는 NAT 로 IP 를 공유하므로 **실패만** 센다). 둘 다 429 + `retryAfterMs` + `Retry-After` 헤더.
없는 입장코드 조회(`GET /api/boards/:code`, `login`, `join`)는 따로 센다: IP 당 1분에 60번 → 그 1분이 끝날 때까지 그 IP 의 코드 조회가 모두
429 `too_many_attempts` ("입장코드를 너무 많이 틀렸어요. 1분 뒤에 다시 해 주세요."). 있는 코드 조회는 세지 않는다.
교사가 PIN 을 초기화하면 새 초기 PIN 이 생기고 PIN 버전이 올라가 **기존 토큰·연결이 모두 무효**(연결은 4001 로 끊김).

### 1.2 자유 입장

기기에서 무작위 `deviceToken`(16~128자 `[A-Za-z0-9_-]`)을 만들어 `localStorage` 에 둔다.
서버는 `ref = "f:" + SHA-256(boardId:deviceToken)` 로 본인 카드를 알아본다(기기 토큰 자체는 저장 안 함).
같은 기기로 다시 `join` 하면 같은 ref(닉네임만 갱신). 보드당 300명까지.

---

## 2. 메시지 공통

- 모두 JSON 텍스트, `t` 가 종류. 최대 64KB.
- **연결 유지**: 문자열 `"ping"` 을 보내면 `"pong"` (DO 를 깨우지 않는 자동 응답, 요금 없음). 30~50초마다 권장.
- **쓰기 메시지**는 `opId`(8~64자 `[A-Za-z0-9_-]`, 예: `crypto.randomUUID()`)를 붙인다.
  서버는 반드시 같은 `opId` 로 `ack` 또는 `error` 를 돌려준다 → 낙관적 반영 후 `ack` 로 확정, `error` 면 되돌림.
- **멱등**: 같은 `opId` 를 다시 보내도 한 번만 적용된다(`ack.result.duplicate = true`).
  새 항목(카드·댓글·공지·열)의 id 는 `(보드, 보낸 사람, opId)` 에서 결정적으로 만들어지므로 DO 가 재시작된 뒤 재전송해도 중복이 안 생긴다.
  좋아요는 토글이 아니라 원하는 상태(`liked: true|false`)를 보낸다. 수정·삭제는 원래 멱등(이미 지워졌으면 `duplicate`).
- **방송 순서**: 서버는 변경을 먼저 모두에게 방송하고 그다음 보낸 사람에게 `ack` 한다. 보낸 사람도 `post.upsert` 등을 받는다.
- **속도 제한**: 연결마다 토큰 버킷(학생 20개·초당 2개, 교사 60개·초당 6개, `sync` 는 5개 몫).
  넘치면 `error{code:"rate_limited", retryAfterMs}`. 계속 넘치면 4008 로 끊김.

## 3. 클라이언트 → 서버

| t | 누가 | 내용 | ack.result |
|---|---|---|---|
| `post.save` | 모두 | `post: PostInput` — `id` 없으면 새 카드 | `{ postId }` |
| `post.delete` | 작성자·교사 | `postId` | `{ postId }` |
| `post.moderate` | 교사 | `postId, action: "approve"\|"hide"\|"unhide"` | `{ postId }` |
| `comment.add` | 모두 | `postId, body` (≤1000자) | `{ postId, commentId }` |
| `comment.delete` | 작성자·교사 | `postId, commentId` | `{ postId, commentId }` |
| `like.set` | 모두 | `postId, liked: boolean` | `{ postId }` |
| `feedback.set` | 교사 | `postId, body` (빈 문자열 = 삭제, ≤3000자) | `{ postId }` |
| `notice.save` | 교사 | `notice: { id?, title, body }` | `{ noticeId }` |
| `notice.delete` | 교사 | `noticeId` | `{ noticeId }` |
| `settings.update` | 교사 | `patch: BoardSettingsPatch` | `{}` |
| `column.save` | 교사(주제별) | `column: { id?, title }` | `{ columnId }` |
| `column.delete` | 교사(주제별) | `columnId` (카드 있으면 `column_not_empty`, 마지막 열은 불가) | `{ columnId }` |
| `column.reorder` | 교사(주제별) | `order: string[]` (모든 열 id) | `{}` |
| `sync` | 모두 | opId 없음. 스냅숏을 다시 받음 | — (`snapshot` 이 옴) |

`PostInput`:

```jsonc
{
  "id": "p…",              // 수정할 때만
  "columnId": "k…",        // 주제별 열: 새 카드는 필수, 수정 때 주면 열 이동
  "title": "새싹 관찰",     // ≤100자
  "body": "떡잎이 두 장…",  // ≤5000자
  "link": "https://…",     // http(s)만, ≤2000자
  "attachments": [         // 최종 목록(순서 포함), 최대 5개. 수정 때 생략하면 기존 유지, [] 면 모두 뺌
    { "id": "a…" },                    // 기존 첨부 유지
    { "uploadToken": "eyJ…" }          // 태스크3 업로드 완료 응답의 token
  ],
  "onBehalfOf": "s:…"      // 교사만: 이 학생 이름으로 새 카드
}
```

제목·내용·링크·첨부가 모두 비면 `empty_post`. 업로드 확인 토큰은 서버가 검증한다: 서명·만료, `boardId` 가 이 보드,
`by` 가 **보내는 사람의 ref**(남의 토큰 사용 불가 → `invalid_upload`), 크기 ≤ 보드 설정.

예:

```json
→ {"t":"post.save","opId":"9b1f0c2e-…","post":{"title":"새싹","attachments":[{"uploadToken":"eyJ…"}]}}
← {"t":"post.upsert","post":{"id":"pX3…","columnId":"s:s:Ab12…","authorName":"김하나","mine":true,"status":"visible",…}}
← {"t":"ack","opId":"9b1f0c2e-…","result":{"postId":"pX3…"}}
```

## 4. 서버 → 클라이언트

| t | 언제 | 누구에게 |
|---|---|---|
| `snapshot` | 접속 직후, `sync`, 익명·열 구성·입장 방식 변경, 명단 변경(이름·학번·닉네임·모둠·구성원 — PIN 등록·초기화만 바뀐 것은 그 학생 연결만 4001 로 끊고 스냅숏은 안 보냄) | 각자 걸러서 |
| `ack` / `error` | 쓰기 결과 | 보낸 사람 |
| `post.upsert` | 카드 생성·수정·승인·숨김 해제·피드백 변경, 작성자 이름 변경 | 그 카드를 볼 수 있는 사람 |
| `post.remove` | 삭제, 또는 그 사람이 더는 못 보게 됨(숨김, 학생 수정으로 승인 대기) | 전에 볼 수 있던 사람 |
| `comment.add` / `comment.remove` | 댓글 | 그 카드를 볼 수 있는 사람 |
| `like.set` | 좋아요 수 변경. `liked` 는 받는 사람 기준 | 그 카드를 볼 수 있는 사람 |
| `notice.upsert` / `notice.remove` | 공지 | 모두 |
| `settings.update` | 설정 변경(전체 값) | 모두 |
| `columns.set` | 열 목록 변경(전체, 받는 사람 기준으로 걸러짐) | 모두 |
| `presence` | 누가 들어오거나 나감 | 모두 (`online` 목록은 교사만) |
| `submission` | 카드 생성·삭제(명단 모드) — 아직 카드 없는 학생 ref 목록 | 교사 |
| `backup.status` | 백업 대기·성공·실패 | 교사 |

클라이언트는 `post.upsert` 를 받으면 같은 id 카드를 **통째로 바꾼다**(댓글 포함). `comment.add` 는 같은 id 가 이미 있으면 무시.

### 4.1 스냅숏 (`BoardSnapshot`)

```jsonc
{
  "board": { "id": "b…", "code": "4821" },
  "settings": { "title": "…", "type": "single", "columnMode": "student", "entryMode": "roster",
                "moderation": false, "locked": false, "anonymous": false,
                "allowComments": true, "allowLikes": true, "maxFileMB": 25, "archived": false },
  "me": { "role": "student", "ref": "s:Ab12…", "name": "별빛", "realName": "박지우", "number": "20303", "nickname": "별빛", "group": "2모둠" },
  "columns": [ { "id": "teacher", "title": "선생님", "kind": "teacher", "position": 0 },
               { "id": "s:s:Ab12…", "title": "별빛", "kind": "student", "ownerRef": "s:Ab12…", "mine": true, "position": 1 } ],
  "posts": [ /* PostView, 오래된 것 먼저 */ ],
  "notices": [ /* 최신 먼저 */ ],
  "members": [ /* 학생 화면, 익명 아닐 때만: { ref, name(닉네임>이름), number, group } */ ],
  "roster": [ /* 교사만: { ref, kind, number, name(실명), nickname, group } */ ],
  "notSubmitted": [ /* 교사·명단 모드만 */ ],
  "backup": { /* 교사만: BackupInfo */ },
  "presence": { "count": 23, "online": [ /* 교사만 */ ] },
  "fileToken": "eyJ…", "fileTokenExpiresAt": 1763180000000,
  "serverTime": 1763130000000
}
```

**파일 보기 주소**: `/api/files/{snapshot.board.id}/{attachment.id}?t={snapshot.fileToken}` (태스크3 라우트).
`fileToken` 은 purpose `"file"`, payload `{ boardId }`, 12시간. 만료 1시간 전부터는 `sync` 로 새 스냅숏을 받으면 새 토큰이 온다.

열 id 규칙: 주제별 = 서버 id(`k…`), 개인별 = `"s:" + ref`, 모둠별 = `"g:" + 모둠 이름`(모둠 없음은 `"g:"`),
개인별·모둠별에서 교사 카드 = `"teacher"`. 카드의 `columnId` 가 어느 열에 놓일지 알려 준다(개인별·모둠별에서 클라이언트가 열을 고르지 않음).

## 5. 가시성 규칙 (서버가 강제)

| 항목 | 교사 | 작성자 본인 | 다른 학생 |
|---|---|---|---|
| `visible` 카드 | ✓ | ✓ | ✓ |
| `pending`(승인 대기)·`hidden` 카드 | ✓ (`status` 표시) | ✓ (`status` 표시) | **안 보냄** (그 카드에 대한 어떤 메시지도) |
| 피드백 | ✓ | ✓ | **안 보냄** (피드백 변경 시 이들에겐 메시지 자체가 없음) |
| 좋아요 | 수 | 수 + 내가 눌렀는지 | 수 + 내가 눌렀는지 (누가 눌렀는지는 아무에게도 안 감) |
| 이름 | 실명 + 학번 | 내 이름(닉네임>이름) | 닉네임 > 이름, 학번 (익명이면 아래) |

**익명 모드** (`anonymous: true`): 학생은 **다른 학생**의 실명·닉네임·학번·실제 ref 를 받지 않는다.
- 카드·댓글 작성자 → `authorName: "익명"`, `authorRef: "a:{별칭}"`, `authorNumber` 없음.
- 개인별 열 → id `"s:a:{별칭}"`, 제목 `"익명 1"`, `"익명 2"` …(별칭 순서라 학번 순서도 안 드러남). 내 열은 내 이름 + `mine: true`.
- `members` 는 보내지 않는다. `presence.online` 은 원래 교사에게만.
- 별칭은 익명을 **켤 때마다 새로** 만든다(익명 아닐 때 본 ref 와 짝지을 수 없게).
- 교사 이름("선생님")과 본인 정보는 그대로.
- 익명·열 구성·입장 방식을 바꾸면 모두에게 새 `snapshot` 이 간다(클라이언트는 상태를 통째로 바꿈).

잠금(`locked`): 학생은 카드·댓글·좋아요·삭제·닉네임 변경·업로드 불가(`locked`). 교사는 가능. 읽기는 그대로.
보관(`archived`): 학생 접속 불가(연결은 4003 으로 끊김), 교사는 읽기만(쓰기는 `archived`).
승인 후 게시(`moderation`): 학생 새 카드는 `pending`. 학생이 `visible` 카드를 고치면 다시 `pending`. 교사 카드는 바로 `visible`.
단일 주제(`type: "single"`): 학생(또는 교사가 대신 쓴 학생)당 카드 1장(`one_card_only`). 교사 자신의 카드는 제한 없음.
여러 장 쓴 학생이 있으면 `single` 로 바꿀 수 없음(`invalid_settings`). 자유 입장 + 모둠별은 불가(`invalid_settings`).

## 6. 오류 코드 (`ErrorCode`)

WS `error.code` 와 REST `{ error: { code, message, retryAfterMs? } }` 가 같은 코드를 쓴다. `message` 는 그대로 화면에 보여도 되는 한국어.

| code | 뜻 |
|---|---|
| `bad_request` | 형식이 틀림 (opId 없음, JSON 아님, 값 종류 틀림, 알 수 없는 설정) |
| `too_large` | 메시지 64KB 초과, 글자 수 초과, 첨부 크기 초과 |
| `rate_limited` | 너무 빠름 (`retryAfterMs`) |
| `unauthorized` | 입장 필요·토큰 무효 → 다시 입장 화면 |
| `forbidden` | 권한 없음 (남의 카드, 교사 전용) |
| `not_found` | 대상 없음 (볼 수 없는 카드도 not_found) |
| `locked` / `archived` | 잠김 / 보관됨 |
| `one_card_only` | 단일 주제 보드에서 두 번째 카드 |
| `comments_disabled` / `likes_disabled` | 꺼져 있음 |
| `limit_reached` | 개수 상한 (첨부 5, 카드 3000, 댓글 300/카드, 공지 50, 열 30, 반 500명, 자유 입장 300명) |
| `column_required` / `column_not_empty` | 주제별 열 관련 |
| `invalid_upload` | 업로드 확인 토큰이 위조·만료·다른 보드·다른 사람 것 |
| `invalid_settings` | 지금 상태와 안 맞는 설정 |
| `empty_post` | 제목·내용·링크·첨부 모두 없음 |
| `invalid_credentials` | 학번 또는 PIN 틀림 (어느 쪽인지 알려 주지 않음) |
| `student_locked` / `too_many_attempts` | PIN 잠금 / IP 시도 제한·없는 입장코드 너무 많이 (`retryAfterMs`) |
| `invalid_pin` | 새 PIN 규칙 위반 |
| `wrong_entry_mode` | 명단 보드에 자유 입장 등 |
| `duplicate` | 학번 중복 |
| `class_in_use` | 보드가 쓰는 반 삭제 |
| `internal` | 서버 문제 (다시 시도) |

## 7. 연결 끊김·재접속

| 종료 코드 | 뜻 | 클라이언트 |
|---|---|---|
| 1000/1001/1006 등 | 네트워크·서버 재시작 | **지수 백오프 재접속** (예: 0.5s → 1 → 2 → 4 … 최대 30s, ±30% 무작위) |
| 4001 `reauth` | 토큰 무효 (PIN 초기화, 명단에서 빠짐, 입장 방식 변경) | 재접속 금지, 토큰 지우고 입장 화면 |
| 4003 `archived` | 보드 보관 | 재접속 금지, 안내 |
| 4004 `deleted` | 보드 삭제 | 재접속 금지, 안내 |
| 4008 `abuse` | 속도 제한 반복 위반 | 몇 초 뒤 재접속 |

`isTerminalClose(code)` 가 재접속하면 안 되는 코드를 알려 준다. 핸드셰이크가 HTTP 오류(401/403/404)로 실패하면
브라우저는 이유를 알 수 없으므로 `GET /api/boards/{code}/me`(학생) 로 원인을 확인한다.

재접속 후 서버는 새 `snapshot` 을 보내므로 클라이언트는 상태를 통째로 바꾼 뒤, `ack` 를 못 받은 쓰기를 **같은 opId 로** 다시 보낸다
(서버가 중복을 막는다). 순번(seq)은 없다: 끊김 사이의 변경분은 스냅숏이 메운다.

## 8. REST — 학생 입장

| 메서드·경로 | 인증 | 요청 → 응답 |
|---|---|---|
| `GET /api/boards/:code` | 없음 | → `BoardPublicInfo { code, title, entryMode, locked, archived }` |
| `POST /api/boards/:code/login` | 없음 | `{ number, pin }` → `LoginResponse` |
| `POST /api/boards/:code/pin` | setupToken | `{ setupToken, newPin }` → `{ token, student }` |
| `POST /api/boards/:code/join` | 없음 | `{ nickname, deviceToken }` → `{ token, student }` |
| `POST /api/boards/:code/nickname` | Bearer | `{ nickname }` → 명단: `{ student }` (반 전체 닉네임, 빈 값이면 실명 표시로) / 자유: `{ token, student }` (새 토큰으로 교체) |
| `GET /api/boards/:code/me` | Bearer | → `{ student }` 또는 401/403 (토큰 상태 확인용) |
| `GET /api/boards/:code/ws` | `?st=` 또는 교사 쿠키 | 웹소켓 |

`code` 는 새 보드면 숫자 4자리(설치 안이 붐비면 5·6자리, 앞자리 0 그대로), 예전 보드면 영숫자 6자(`[A-HJKMNP-Z2-9]`, 예: `K7QX2M`).
대소문자·공백·하이픈·전각 글자 무시. 모양이 틀리거나 없는 코드는 똑같이 `404 {"error":{"code":"not_found","message":"입장코드를 다시 확인해 주세요."}}`.
다른 보드 학생 토큰으로 없는 코드를 물으면 다른 보드와 똑같이 401 (코드가 있는지 알려 주지 않음).
쓰기 요청은 다른 사이트 `Origin` 이면 403.

```http
POST /api/boards/4821/login
{"number":"20301","pin":"4821"}
→ 200 {"status":"pin_setup","setupToken":"eyJ…","student":{"ref":"s:Ab12…","name":"김하나","realName":"김하나","number":"20301","nickname":""}}
→ 401 {"error":{"code":"invalid_credentials","message":"학번 또는 PIN을 다시 확인해 주세요."}}
→ 429 {"error":{"code":"student_locked","message":"PIN을 5번 틀렸어요. 5분 뒤에 다시 해 주세요.","retryAfterMs":300000}}
```

## 9. REST — 교사 관리 (`/api/teacher/*`, 교사 쿠키 필수, 쓰기는 같은 출처만)

| 메서드·경로 | 요청 → 응답 |
|---|---|
| `GET /api/teacher/boards?archived=0\|1\|all` | → `{ boards: BoardSummary[] }` (기본: 보관 안 된 것) |
| `POST /api/teacher/boards` | `CreateBoardRequest { title, classId?, type?, columnMode?, entryMode?, moderation?, locked?, anonymous?, allowComments?, allowLikes?, maxFileMB?, description? }` → 201 `BoardDetail` |
| `GET /api/teacher/boards/:id` | → `BoardDetail` (요약 + 설정 + 백업 상태) |
| `PATCH /api/teacher/boards/:id` | `BoardSettingsPatch` (이름 바꾸기 포함) → `BoardDetail`. 웹소켓 `settings.update` 와 같은 처리 |
| `POST /api/teacher/boards/:id/archive` · `/unarchive` | → `BoardDetail` |
| `DELETE /api/teacher/boards/:id` | → 204 (Drive 폴더는 남김) |
| `PUT /api/teacher/boards/:id/class` | `{ classId \| null }` → `BoardDetail` (명단 사본을 보드로 보냄) |
| `GET /api/teacher/recent-posts?limit=12` | → `{ posts: RecentPost[] }` (보관 안 된 보드, 최대 50, 백업 알람 때 갱신 → 최대 약 30초 늦음). 사진이 있으면 `image: { id, width?, height? }` 와 그 보드의 `fileToken`(12시간) → `/api/files/{boardId}/{image.id}?t={fileToken}` |
| `GET /api/teacher/classes` | → `{ classes: ClassSummary[] }` |
| `POST /api/teacher/classes` | `{ name, students?: StudentRowInput[] }` → 201 `{ class, students }` |
| `PATCH /api/teacher/classes/:id` | `{ name }` → `{ class }` |
| `DELETE /api/teacher/classes/:id` | → 204 (보드가 쓰면 409 `class_in_use`) |
| `GET /api/teacher/classes/:id/students` | → `{ students: TeacherStudent[] }` (학번순, 등록 전이면 `initialPin`) |
| `POST /api/teacher/classes/:id/students` | `{ students: StudentRowInput[] }` → 201 `{ added }` (CSV 파싱 결과. 한 줄이라도 틀리면 "N번째 줄: …" 오류로 아무것도 안 넣음) |
| `PATCH /api/teacher/students/:id` | `{ number?, name?, group?, nickname? }` → `{ student }` |
| `DELETE /api/teacher/students/:id` | → 204 (그 학생 연결은 4001 로 끊김, 카드는 남음) |
| `POST /api/teacher/students/:id/reset-pin` | → `{ student }` (새 `initialPin`) |
| `POST /api/teacher/students/:id/unlock` | → `{ student }` (5회 실패 잠금 해제) |
| `GET /api/teacher/students/:id/portfolio` | → `PortfolioResponse` (그 반에 연결된 보드들의 그 학생 카드, 교사 보기) |

명단 CSV 열(프런트가 파싱): `학번,이름,PIN,모둠,닉네임` — 학번·이름 필수, 나머지 선택. PIN 이 비면 무작위.

Drive 관련 경로(업로드, 파일 보기, 시트 내보내기, `GET /api/boards/:code/drive`)는 태스크3 문서/타입(`src/shared/files.ts`) 참고.
`GET /api/boards/:code/drive` 의 `backup.status` 는 이 보드 DO 의 백업 상태(`getDriveState().backupError/backupPending/lastBackupAt`)에서 나온다.

## 10. 백업

변경이 생기면 30초 뒤 알람 한 번(그 사이 변경은 한 번에 모임 — 알람을 미루지 않으므로 계속 바빠도 30초마다 저장).
알람은 ① 교사 대시보드용 통계·최근 글을 Registry 로 보내고 ② `writeBoardBackup` 으로 `게시글 백업.json` 을 갱신한다.
실패하면 30초·1분·2분·4분… 최대 30분 간격으로 8번까지 다시 시도하고, 그래도 안 되면 다음 변경 때까지 쉰다.
교사는 `snapshot.backup` 과 `backup.status` 로 `state: never|pending|ok|error|unavailable`(Drive 연결 끊김), 마지막 성공·오류·다음 시도 시각을 본다.
`lastErrorCode` 가 `api_disabled` 이면 교사 Google Cloud 프로젝트에서 Drive API 가 꺼진 것(403 `accessNotConfigured`) → 화면이 `/setup#help-api` 로 안내한다.

## 11. 요금(무료 요금제) 관련 설계

- 한 번의 쓰기 = WS 메시지 1건(요청 1건) + SQLite 행 쓰기 1~3건. 타자마다 보내지 말고 저장할 때만 보낸다.
- `ping`/`pong` 은 자동 응답이라 DO 를 깨우지 않는다. presence 는 접속·종료 때만 방송(따로 하트비트 없음).
- 접속 1번 = Worker 요청 1 + Registry RPC 1 + Board 요청 1.
- 서버 → 클라이언트 방송은 요금 대상이 아니다. 백업·통계는 30초에 최대 한 번(알람 1 + Registry RPC 1 + Drive 호출).
- DO 의 메모리 값(스냅숏 캐시, 구성원 캐시, 최근 opId)은 모두 SQLite 에서 다시 만들 수 있어 언제든 hibernation 된다.
