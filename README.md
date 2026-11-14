# 나눔보드

수업 시간에 학생들과 함께 쓰는 **실시간 게시판**이에요. 글·사진·댓글·좋아요가 바로바로 보이고, 학생은 로그인 없이 입장 코드로 들어와요.

- 선생님 **한 분이 자기 계정에 한 벌** 설치해서 쓰는 방식이에요. 학생 글은 선생님 Cloudflare 계정에, 사진·파일은 선생님 Google 드라이브에 저장되고, 만든 사람에게는 아무 정보도 가지 않아요.
- Cloudflare 무료 요금제, Google 무료 계정으로 충분해요. 카드 등록이 필요 없어요.

## 설치하기

**[친절한 설치 안내 보기](https://sanchucksatgat.github.io/-/)** — 화면 그림과 함께 한 단계씩 안내해요. (약 40분, 컴퓨터 권장)

안내 순서 요약:

1. GitHub, Cloudflare 무료 가입
2. 아래 버튼으로 설치 → 내 나눔보드 주소(`https://nanumboard.○○.workers.dev`)가 생겨요
3. Google Cloud에서 로그인용 출입증(OAuth 클라이언트) 만들기 — 주소를 알고 나서 해야 해요
4. Cloudflare에 출입증 값(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET) 넣기
5. 내 나눔보드에 Google로 처음 로그인 → 그 계정이 주인이 돼요. `내 주소/setup` 에서 설치 점검까지!

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/sanchucksatgat/-)

> 설치 버튼 화면에서는 Google 값을 묻지 않아요. 설치가 끝난 다음 안내에 따라 넣으면 돼요.

설치한 나눔보드에서도 `https://내주소/setup` 을 열면 같은 안내가 나오고, 마지막 단계에서 설치가 잘 됐는지 실제로 점검해 줘요.

## 업데이트·비용·개인정보

설치 안내 페이지 아래쪽의 **업데이트하는 법**, **비용이 드나요?**, **학생 개인정보는 어디에 저장되나요?** 를 보세요.

---

## 개발자용

```bash
npm ci
cp .dev.vars.example .dev.vars   # 주석(#)을 풀고 값을 채우면 로컬에서 Google 로그인까지 시험 가능
npm run dev                      # 프런트 빌드 + wrangler dev (http://localhost:8787)
npm run typecheck && npm test
npm run build:guide              # 설치 안내만 정적 페이지로 → dist/guide/
```

- 설계: [docs/DESIGN.md](docs/DESIGN.md), 실시간 프로토콜: [docs/PROTOCOL.md](docs/PROTOCOL.md), 배포 조사: [docs/RESEARCH-deploy.md](docs/RESEARCH-deploy.md)
- 원본 저장소 주소는 `web/setup/config.ts` 의 `SOURCE_REPO_URL` 과 이 README 의 버튼·안내 링크 두 곳에 있어요. 저장소를 옮기면 함께 바꿔 주세요.
- 설치 안내 공개 페이지는 `.github/workflows/guide-pages.yml` 이 GitHub Pages 로 올려요. 저장소 설정 → Pages → Source 를 **GitHub Actions** 로 바꾸고, 저장소 변수 `PUBLISH_GUIDE` 를 `true` 로 만들어야 동작해요(선생님들이 설치하며 생기는 복사본에서는 돌지 않게 하려는 장치).
