import type { ComponentChildren, JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import { LINKS, SCOPES } from "./config";
import { CopyField, Ext, UI } from "./ui";

/** 도움말이 쓰는 값 (선생님이 붙여 넣은 주소 등). 아직 모르면 비어 있다. */
export interface HelpCtx {
  redirectUri?: string;
  origin?: string;
  goStep: (id: string) => void;
}

interface HelpItem {
  title: string;
  body: (ctx: HelpCtx) => JSX.Element;
}

function GoStep(props: { ctx: HelpCtx; id: string; children: ComponentChildren }) {
  return (
    <button type="button" class="btn btn-small" onClick={() => props.ctx.goStep(props.id)}>
      {props.children}
    </button>
  );
}

/**
 * 자주 막히는 곳. 키는 주소 조각(#help-키)으로도 쓰인다.
 * 서버 오류 페이지(src/worker/auth/routes.ts)가 /setup#help-키 로 연결하므로 키 이름을 바꾸지 말 것.
 */
export const HELP = {
  school: {
    title: "학교 계정으로는 막혀요 (관리자 승인이 필요하다는 화면)",
    body: () => (
      <>
        <p>
          학교 Google 계정(교육청·학교가 관리하는 계정)은 관리자가 막아 두는 경우가 많아요. 예를 들어 “관리자가 이 앱을 검토해야 합니다”,
          <code>admin_policy_enforced</code> 같은 화면이 나오거나, Google Cloud에서 프로젝트를 만들 권한이 없다고 나와요.
        </p>
        <ul>
          <li>
            <strong>가장 쉬운 방법:</strong> 개인 Gmail 계정으로 처음부터 진행하세요. 이때 학생 사진·파일은 그 개인 계정의 드라이브에 저장돼요.
          </li>
          <li>
            <strong>학교 드라이브에 꼭 저장하고 싶다면:</strong> Google Cloud 설정은 개인 계정으로 하고, 나눔보드에 처음 로그인할 때만 학교 계정을 고르세요. 그래도 막히면 학교
            관리자에게 “클라이언트 ID ○○○ 앱을 신뢰할 수 있는 앱으로 허용해 주세요”라고 요청해야 해요.
          </li>
        </ul>
      </>
    ),
  },
  build: {
    title: "설치(빌드)가 실패했다고 나와요",
    body: () => (
      <>
        <ol>
          <li>
            Cloudflare 화면의 빌드 기록에서 빨간 줄 근처 내용을 확인해 보세요. 일시적인 문제라면 <UI ko="빌드 다시 시도" en="Retry build" />만 눌러도 돼요.
          </li>
          <li>
            “이름이 이미 있어요(already exists)” 같은 말이 보이면, 설치 버튼을 다시 눌러 <UI ko="Worker 이름" en="Worker name" />을 다른 이름(예:{" "}
            <code>nanumboard2</code>)으로 바꿔 보세요.
          </li>
          <li>그래도 안 되면 빌드 기록의 내용을 복사해서 나눔보드를 소개해 준 분께 보내 주세요. 선생님 비밀번호는 들어 있지 않아요.</li>
        </ol>
      </>
    ),
  },
  address: {
    title: "내 나눔보드 주소를 못 찾겠어요 / 주소를 열면 오류가 나요",
    body: () => (
      <>
        <ul>
          <li>
            <Ext href={LINKS.cloudflareWorkers}>Cloudflare 대시보드</Ext> → <UI ko="Workers 및 Pages" en="Workers & Pages" /> → 목록에서 <code>nanumboard</code>를 누르면
            위쪽에 <code>….workers.dev</code> 주소가 보여요.
          </li>
          <li>방금 설치했다면 주소가 퍼지는 데 1~2분 걸릴 수 있어요. 잠시 뒤 새로 고침 해 보세요.</li>
          <li>
            주소는 <code>https://Worker이름.내하위도메인.workers.dev</code> 모양이에요. Cloudflare 첫 화면의 <UI ko="하위 도메인" en="Your subdomain" />을 나중에 바꾸면
            나눔보드 주소도 바뀌어서 Google 설정을 다시 해야 하니, 설치 뒤에는 바꾸지 마세요.
          </li>
        </ul>
      </>
    ),
  },
  project: {
    title: "Google Cloud에서 프로젝트를 만들 수 없어요",
    body: () => (
      <ul>
        <li>학교 계정이라면 권한이 막혀 있을 수 있어요. 개인 Gmail 계정으로 로그인해서 다시 해 보세요.</li>
        <li>처음 들어가면 국가 선택과 서비스 약관 동의 창이 먼저 나와요. 동의해야 다음으로 넘어가요. 결제 정보(카드)는 필요 없어요.</li>
        <li>“프로젝트 할당량” 이야기가 나오면 예전에 만든 쓰지 않는 프로젝트를 지우거나, 그 프로젝트를 그대로 써도 돼요.</li>
      </ul>
    ),
  },
  "scope-list": {
    title: "권한 목록에 drive.file 이 안 보여요",
    body: (ctx) => (
      <>
        <p>
          목록에서 찾기 어렵다면 목록 아래의 <UI ko="직접 범위 추가" en="Manually add scopes" /> 칸에 아래 세 줄을 그대로 붙여 넣고{" "}
          <UI ko="표에 추가" en="Add to table" />를 누르세요. Google Drive API를 아직 안 켰다면 먼저 켜 주세요.
        </p>
        <CopyField label="세 가지 범위 (한꺼번에 붙여 넣기)" value={SCOPES.map((s) => s.value).join("\n")} />
        <p>
          <GoStep ctx={ctx} id="driveapi">
            Drive API 켜기 단계로
          </GoStep>
        </p>
      </>
    ),
  },
  "secret-lost": {
    title: "보안 비밀번호를 복사하지 못하고 창을 닫았어요",
    body: () => (
      <ol>
        <li>
          Google 인증 플랫폼 → <UI ko="클라이언트" en="Clients" /> → 방금 만든 클라이언트 이름을 눌러요.
        </li>
        <li>
          <UI ko="보안 비밀번호 추가" en="Add secret" />를 눌러 새 비밀번호를 만들고 바로 복사해요. (예전 비밀번호는 보이지 않아요. 이제 Google은 만들 때 한 번만
          보여 줘요.)
        </li>
        <li>새 비밀번호를 Cloudflare의 GOOGLE_CLIENT_SECRET 값으로 넣으면 돼요.</li>
      </ol>
    ),
  },
  redirect: {
    title: "“오류 400: redirect_uri_mismatch” 가 나와요",
    body: (ctx) => (
      <>
        <p>Google에 적은 ‘승인된 리디렉션 URI’가 나눔보드 주소와 한 글자라도 다르면 나와요. 자주 하는 실수:</p>
        <ul>
          <li>
            끝에 <code>/</code>나 띄어쓰기가 붙음, <code>http</code>로 적음(꼭 <code>https</code>)
          </li>
          <li>
            <code>/auth/google/callback</code>을 빠뜨림
          </li>
          <li>‘승인된 자바스크립트 원본’ 칸에만 적고 ‘승인된 리디렉션 URI’ 칸에는 안 적음</li>
          <li>Worker 이름이나 하위 도메인을 나중에 바꿈</li>
        </ul>
        {ctx.redirectUri ? (
          <CopyField label="정확한 리디렉션 URI (이것을 그대로)" value={ctx.redirectUri} />
        ) : (
          <p>
            <GoStep ctx={ctx} id="address">
              내 주소 넣고 정확한 값 만들기
            </GoStep>
          </p>
        )}
        <p class="hint">Google 클라이언트 화면에서 고친 뒤 저장하고, 몇 분 뒤에 다시 로그인해 보세요. 바로 반영되지 않을 수 있어요.</p>
      </>
    ),
  },
  "access-denied": {
    title: "“403 오류: access_denied” 또는 “로그인이 취소되었어요”가 나와요",
    body: (ctx) => (
      <ul>
        <li>
          <strong>앱이 아직 ‘테스트 중’이에요.</strong> Google 인증 플랫폼 → <UI ko="대상" en="Audience" />에서 <UI ko="앱 게시" en="Publish app" />를 눌러 ‘프로덕션’으로
          바꿔 주세요.{" "}
          <GoStep ctx={ctx} id="publish">
            앱 게시 단계로
          </GoStep>
        </li>
        <li>
          <strong>다른 계정으로 들어갔어요.</strong> 계정 고르는 화면에서 나눔보드를 연결할 계정을 골랐는지 확인해 주세요.
        </li>
        <li>
          동의 화면에서 <UI ko="취소" en="Cancel" />를 눌렀다면 다시 로그인하고 <UI ko="계속" en="Continue" />을 눌러 주세요.
        </li>
        <li>학교 계정이라면 학교 관리자가 막았을 수 있어요(아래 ‘학교 계정’ 도움말).</li>
      </ul>
    ),
  },
  unverified: {
    title: "“Google에서 확인하지 않은 앱” 화면이 나와요",
    body: (ctx) => (
      <>
        <p>
          선생님이 직접 만든 앱이라서 나올 수 있는 화면이에요. 나눔보드는 선생님 계정에 설치된 선생님 것이니 걱정하지 않아도 돼요. 왼쪽 아래{" "}
          <UI ko="고급" en="Advanced" /> → <UI ko="(안전하지 않은 페이지)로 이동" en="Go to … (unsafe)" />을 누르면 계속할 수 있어요.
        </p>
        <p>
          이 화면은 보통 앱이 ‘테스트 중’일 때 나와요. 아직 앱 게시를 안 했다면 해 두세요. 그래야 7일마다 연결이 끊기지 않아요.{" "}
          <GoStep ctx={ctx} id="publish">
            앱 게시 단계로
          </GoStep>
        </p>
        <p class="hint">
          로그인 화면에 ‘나눔보드’ 대신 주소(…workers.dev)가 보이는 것도 정상이에요. 로고를 올리면 Google 심사가 필요해지니 로고는 올리지 마세요.
        </p>
      </>
    ),
  },
  "not-configured": {
    title: "“설정이 필요해요” 화면이 계속 나와요",
    body: (ctx) => (
      <ul>
        <li>
          Cloudflare에 넣은 이름이 정확히 <code>GOOGLE_CLIENT_ID</code>, <code>GOOGLE_CLIENT_SECRET</code>인지(대문자, 밑줄) 확인해 주세요.
        </li>
        <li>
          값을 넣은 뒤 <UI ko="배포" en="Deploy" />를 눌러야 적용돼요. 누른 뒤 1분쯤 기다렸다가 새로 고침 해 보세요.
        </li>
        <li>
          <GoStep ctx={ctx} id="keys">
            Cloudflare에 넣기 단계 다시 보기
          </GoStep>
        </li>
      </ul>
    ),
  },
  secret: {
    title: "“클라이언트 ID나 보안 비밀번호가 맞지 않아요” / “Google과 연결하는 중 문제”",
    body: (ctx) => (
      <ul>
        <li>Cloudflare의 GOOGLE_CLIENT_SECRET에 클라이언트 ID를 잘못 넣었거나, 앞뒤에 띄어쓰기가 들어갔을 수 있어요.</li>
        <li>클라이언트 ID와 보안 비밀번호가 같은 클라이언트의 것인지 확인해 주세요 (클라이언트를 여러 개 만들었다면 헷갈리기 쉬워요).</li>
        <li>
          비밀번호를 잃어버렸다면 새로 만들 수 있어요(‘보안 비밀번호를 복사하지 못하고 창을 닫았어요’ 도움말).{" "}
          <GoStep ctx={ctx} id="keys">
            Cloudflare에 넣기 단계로
          </GoStep>
        </li>
      </ul>
    ),
  },
  scope: {
    title: "드라이브 권한이 빠졌다고 나와요 (동의 화면에서 체크를 안 함)",
    body: () => (
      <>
        <p>
          Google 동의 화면에서 “Google Drive 파일 보기, 수정, 생성, 삭제(나눔보드가 사용하는 파일만)” 같은 줄 옆의 <strong>체크 칸을 켜야</strong> 사진·파일을 올릴 수
          있어요.
        </p>
        <ol>
          <li>나눔보드에서 로그아웃하고 다시 로그인해요.</li>
          <li>동의 화면에서 드라이브 항목을 체크(또는 <UI ko="모두 선택" en="Select all" />)하고 <UI ko="계속" en="Continue" />을 눌러요.</li>
        </ol>
        <p class="hint">
          체크 칸이 안 보이고 바로 넘어가면 <Ext href={LINKS.googlePermissions}>Google 계정 → 서드파티 연결</Ext>에서 나눔보드(또는 workers.dev) 연결을 지운 뒤 다시
          로그인해 보세요.
        </p>
      </>
    ),
  },
  "7days": {
    title: "일주일쯤 지나면 드라이브 연결이 끊겨요",
    body: (ctx) => (
      <>
        <p>
          앱이 ‘테스트 중’이면 Google이 7일 뒤 연결을 끊어요. <UI ko="대상" en="Audience" />에서 <UI ko="앱 게시" en="Publish app" />로 ‘프로덕션’으로 바꾼 다음,{" "}
          <strong>나눔보드에 한 번 다시 로그인</strong>하세요. 게시 전에 받은 연결은 여전히 7일 제한이 있어서 다시 로그인해야 풀려요.
        </p>
        <p>
          <GoStep ctx={ctx} id="publish">
            앱 게시 단계로
          </GoStep>
        </p>
      </>
    ),
  },
  owner: {
    title: "다른 계정이 선생님(주인)으로 등록됐어요",
    body: (ctx) => (
      <>
        <p>나눔보드는 처음 로그인한 Google 계정을 주인으로 정해요. 다른 계정이 먼저 로그인했다면 이렇게 바꿀 수 있어요.</p>
        <ol>
          <li>
            Cloudflare → 나눔보드 → <UI ko="설정" en="Settings" /> → <UI ko="변수 및 비밀" en="Variables and Secrets" />에 이름 <code>OWNER_EMAIL</code>, 값은 주인이
            될 Gmail 주소로 추가하고 <UI ko="배포" en="Deploy" />를 눌러요.
          </li>
          <li>그 계정으로 나눔보드에 로그인하면 주인이 바뀌어요. 이후에는 그 계정만 들어올 수 있어요.</li>
        </ol>
        <p class="hint">
          주인이 바뀌면 드라이브 폴더도 새 계정 드라이브에 새로 만들어져요. 이미 올린 사진·파일은 예전 계정 드라이브에 남아 있어요.{" "}
          <GoStep ctx={ctx} id="keys">
            Cloudflare에 넣기 단계로
          </GoStep>
        </p>
      </>
    ),
  },
  api: {
    title: "Google Drive API가 꺼져 있다고 나와요",
    body: () => (
      <p>
        <Ext href={LINKS.gcpDriveApi}>Google Drive API 페이지</Ext>를 열고, 화면 위쪽에 나눔보드용 프로젝트 이름이 보이는지 확인한 뒤 <UI ko="사용" en="Enable" />을 눌러
        주세요. 켠 뒤 1~2분 지나서 다시 점검하세요.
      </p>
    ),
  },
  idle: {
    title: "방학 동안 안 썼더니 로그인이 안 돼요",
    body: (ctx) => (
      <ul>
        <li>6개월쯤 쓰지 않으면 Google이 연결을 끊을 수 있어요. 나눔보드에 다시 로그인하면 대부분 해결돼요.</li>
        <li>
          Google은 오래(6개월쯤) 쓰지 않은 OAuth 클라이언트를 지우기도 해요. 그러면 클라이언트를 새로 만들고, Cloudflare의 두 값을 새 값으로 바꿔 주세요.{" "}
          <GoStep ctx={ctx} id="client">
            클라이언트 만들기 단계로
          </GoStep>
        </li>
      </ul>
    ),
  },
} satisfies Record<string, HelpItem>;

export type HelpId = keyof typeof HELP;

/** 각 단계 아래 “여기서 막혔어요” (id 없이, 접었다 펴기) */
export function Stuck(props: { ids: HelpId[]; ctx: HelpCtx }) {
  return (
    <details class="su-stuck">
      <summary>여기서 막혔어요</summary>
      <div class="su-stuck-list">
        {props.ids.map((id) => (
          <details class="su-help" key={id}>
            <summary>{HELP[id].title}</summary>
            <div class="su-help-body">{HELP[id].body(props.ctx)}</div>
          </details>
        ))}
      </div>
    </details>
  );
}

/** 모든 도움말 (주소 #help-키 로 바로 열 수 있음) */
export function HelpIndex(props: { ctx: HelpCtx }) {
  const [openId, setOpenId] = useState<string | null>(null);
  useEffect(() => {
    const sync = () => {
      const h = decodeURIComponent(location.hash.slice(1));
      if (h.startsWith("help-")) {
        setOpenId(h.slice(5));
        requestAnimationFrame(() => document.getElementById(h)?.scrollIntoView({ block: "start" }));
      }
    };
    sync();
    addEventListener("hashchange", sync);
    return () => removeEventListener("hashchange", sync);
  }, []);
  return (
    <div class="su-help-index">
      {(Object.keys(HELP) as HelpId[]).map((id) => (
        <details class="su-help" id={`help-${id}`} key={id} open={openId === id}>
          <summary>{HELP[id].title}</summary>
          <div class="su-help-body">{HELP[id].body(props.ctx)}</div>
        </details>
      ))}
    </div>
  );
}
