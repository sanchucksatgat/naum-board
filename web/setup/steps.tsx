import type { JSX } from "preact";
import { useState } from "preact/hooks";
import { DEFAULT_WORKER_NAME, DEPLOY_URL, LINKS, SCOPES } from "./config";
import { Stuck, type HelpCtx } from "./help";
import type { SetupState } from "./state";
import { Callout, CopyField, Ext, MButton, MChoice, MField, Mock, MRow, MText, MTitle, Steps, Term, UI } from "./ui";
import { checkClientId, checkEmail, checkInstanceUrl, derivedFromOrigin, looksLikeClientSecret } from "./validate";
import { LiveCheck } from "./LiveCheck";

export type Mode = "guide" | "instance";

export interface StepProps {
  state: SetupState;
  update: (patch: Partial<SetupState>) => void;
  mode: Mode;
  derived: ReturnType<typeof derivedFromOrigin> | null;
  ctx: HelpCtx;
}

export interface StepDef {
  id: string;
  group: string;
  title: string;
  minutes: number;
  /** 다음으로 가기 전에 꼭 있어야 하는 값이 없을 때의 안내 */
  blocker?: (p: StepProps) => string | null;
  render: (p: StepProps) => JSX.Element;
}

function NeedAddress(p: StepProps) {
  return (
    <Callout kind="warn" title="먼저 내 나눔보드 주소가 필요해요">
      <button type="button" class="btn btn-small" onClick={() => p.ctx.goStep("address")}>
        주소 넣으러 가기
      </button>
    </Callout>
  );
}

/* ───────────────────────── 준비 ───────────────────────── */

function StartStep(p: StepProps) {
  return (
    <>
      <p>
        나눔보드는 <strong>선생님 계정에 선생님 것으로 한 벌 설치</strong>해서 쓰는 수업용 게시판이에요. 처음 한 번만 설치하면 그다음부터는 주소만 열면 돼요. 화면을 따라
        하나씩 누르기만 하면 되고, 코드를 몰라도 괜찮아요.
      </p>
      <div class="su-need">
        <strong>준비물</strong>
        <ul>
          <li>컴퓨터(휴대폰보다 큰 화면이 편해요)와 약 40분</li>
          <li>Google 계정 1개 — 학생 사진·파일이 이 계정의 Google 드라이브에 저장돼요</li>
          <li>이메일 주소 1개 — GitHub, Cloudflare 가입에 써요 (Gmail 주소 그대로 써도 돼요)</li>
          <li>돈은 들지 않아요. 카드 등록도 필요 없어요.</li>
        </ul>
      </div>
      <fieldset class="su-choice">
        <legend>어떤 Google 계정으로 할까요?</legend>
        <label class={`su-choice-item${p.state.account === "personal" ? " su-on" : ""}`}>
          <input type="radio" name="acct" checked={p.state.account === "personal"} onChange={() => p.update({ account: "personal" })} />
          <span>
            <strong>개인 Gmail 계정 (추천)</strong>
            <span class="hint">막히는 곳 없이 가장 쉽게 끝나요. 파일은 개인 드라이브(무료 15GB)에 저장돼요.</span>
          </span>
        </label>
        <label class={`su-choice-item${p.state.account === "school" ? " su-on" : ""}`}>
          <input type="radio" name="acct" checked={p.state.account === "school"} onChange={() => p.update({ account: "school" })} />
          <span>
            <strong>학교(교육청) Google 계정</strong>
            <span class="hint">학교 드라이브에 저장돼요. 다만 관리자가 막아 두어 중간에 멈출 수 있어요.</span>
          </span>
        </label>
      </fieldset>
      {p.state.account === "school" && (
        <Callout kind="warn" title="학교 계정은 이렇게 해 보세요">
          Google Cloud 설정(6~12단계)은 <strong>개인 Gmail</strong>로 하고, 마지막 ‘첫 로그인’ 단계에서만 학교 계정을 고르세요. 그래도 “관리자 승인이 필요해요” 화면이
          나오면 개인 계정으로 바꾸거나 학교 관리자에게 앱 허용을 요청해야 해요.
        </Callout>
      )}
      <Callout kind="info" title="중간에 그만둬도 괜찮아요">
        어디까지 했는지 이 브라우저에 저장돼요. 나중에 이 페이지를 다시 열면 이어서 할 수 있어요.
      </Callout>
      <Stuck ids={["school"]} ctx={p.ctx} />
    </>
  );
}

function GithubStep(p: StepProps) {
  return (
    <>
      <p>
        <Term word="GitHub">프로그램 코드를 보관하는 무료 사이트</Term>에 나눔보드 프로그램 사본이 선생님 이름으로 하나 만들어져요. 그래서 계정이 필요해요. 학생 정보는
        여기에 저장되지 않아요.
      </p>
      <Steps>
        <li>
          <Ext href={LINKS.github}>GitHub 가입 페이지</Ext>를 열어요. (화면이 영어로 나와요.)
        </li>
        <li>
          이메일, 비밀번호, 사용자 이름(<UI ko="Username" />, 영어·숫자)을 적고 <UI ko="Continue" />를 눌러요.
        </li>
        <li>퍼즐 확인을 하고, 이메일로 온 숫자 코드를 넣으면 끝이에요. 그다음 질문들은 건너뛰어도 돼요(Skip).</li>
      </Steps>
      <Callout kind="ok">이미 GitHub 계정이 있다면 로그인만 해 두고 다음으로 넘어가세요.</Callout>
    </>
  );
}

function CloudflareStep(p: StepProps) {
  return (
    <>
      <p>
        <Term word="Cloudflare">나눔보드가 실제로 돌아가는 인터넷 서버를 무료로 빌려주는 회사</Term> 계정을 만들어요. 학생 글은 여기 선생님 계정 안에 저장돼요.
      </p>
      <Steps>
        <li>
          <Ext href={LINKS.cloudflare}>Cloudflare 가입 페이지</Ext>에서 이메일과 비밀번호로 가입해요.
        </li>
        <li>이메일로 온 확인 메일의 링크를 눌러요.</li>
        <li>“무엇을 하고 싶나요?” 같은 안내 질문이 나오면 건너뛰어도 돼요. 요금제를 고르라고 하면 무료(Free)를 고르세요.</li>
      </Steps>
      <Callout kind="info">
        Cloudflare 화면은 오른쪽 위 메뉴에서 한국어로 바꿀 수 있어요. 이 안내는 한국어 이름과 영어 이름을 함께 적어 둘게요.
      </Callout>
    </>
  );
}

/* ───────────────────────── 설치 ───────────────────────── */

function DeployStep(p: StepProps) {
  return (
    <>
      <p>이제 버튼 하나로 선생님 Cloudflare 계정에 나눔보드를 설치해요. 설치는 2~3분이면 끝나요.</p>
      <p>
        <Ext href={DEPLOY_URL} button>
          Cloudflare에 설치하기
        </Ext>
      </p>
      <Steps>
        <li>버튼을 누르면 Cloudflare 로그인 화면이 나와요. 방금 만든 계정으로 로그인해요.</li>
        <li>
          <UI ko="Git 계정" en="Git account" /> 칸에서 GitHub을 연결해요. GitHub 창이 뜨면 <UI ko="Authorize" />(허락)를 눌러요.
        </li>
        <li>
          <UI ko="Worker 이름" en="Worker name" />은 <code>{DEFAULT_WORKER_NAME}</code> 그대로 두는 걸 추천해요. 이 이름이 주소 맨 앞에 들어가요.
        </li>
        <li>
          <UI ko="비공개 Git 저장소 만들기" en="Create private Git repository" />는 켜도 되고 꺼도 돼요. 프로그램 코드만 들어 있어요.
        </li>
        <li>
          맨 아래 <UI ko="만들기 및 배포" en="Create and deploy" /> 버튼을 누르고 기다려요.
        </li>
      </Steps>
      <Mock app="Cloudflare 설치 화면" url="deploy.workers.cloudflare.com" caption="설치 버튼을 누르면 나오는 설정 화면(단순화한 그림). ①~③만 확인하면 돼요.">
        <MTitle>애플리케이션 설정 (Set up your application)</MTitle>
        <MField label="Git 계정 (Git account)" value="내 GitHub 이름" hl={1} />
        <MField label="저장소 이름 (Repository name)" value="nanumboard" />
        <MChoice options={["비공개 Git 저장소 만들기 (Create private Git repository)"]} selected={-1} check />
        <MField label="Worker 이름 (Worker name)" value={DEFAULT_WORKER_NAME} hl={2} />
        <MRow end>
          <MButton label="만들기 및 배포 (Create and deploy)" primary hl={3} />
        </MRow>
      </Mock>
      <Callout kind="info" title="Google 정보를 넣는 칸은 없어요">
        Google 로그인 정보는 설치가 끝나고 주소가 생긴 다음에 넣어요. 지금은 버튼만 누르면 돼요.
      </Callout>
      <Stuck ids={["build"]} ctx={p.ctx} />
    </>
  );
}

function AddressStep(p: StepProps) {
  const [draft, setDraft] = useState(p.state.instanceUrl);
  const [touched, setTouched] = useState(false);
  const res = checkInstanceUrl(draft);
  if (p.mode === "instance" && p.derived) {
    return (
      <>
        <Callout kind="ok" title="설치가 잘 됐어요!">
          지금 보고 있는 이 페이지가 바로 선생님 나눔보드예요. 주소를 자동으로 알아냈어요.
        </Callout>
        <CopyField label="내 나눔보드 주소" value={p.derived.origin} big hint="이 주소를 즐겨찾기 해 두세요. 학생들도 이 주소로 들어와요." />
      </>
    );
  }
  const [savedNote, setSavedNote] = useState<string | null>(null);
  const save = () => {
    setTouched(true);
    if (res.ok) {
      p.update({ instanceUrl: res.value });
      setSavedNote(res.note ?? null);
      setDraft(res.value);
    }
  };
  return (
    <>
      <p>설치가 끝나면 선생님 나눔보드의 주소가 생겨요. 이 주소로 Google 설정에 넣을 값을 만들어 드릴게요.</p>
      <Steps>
        <li>
          설치 화면에서 성공 표시가 나오면 <code>https://…workers.dev</code>로 끝나는 주소가 보여요. 안 보이면{" "}
          <Ext href={LINKS.cloudflareWorkers}>Cloudflare 대시보드</Ext> → <UI ko="Workers 및 Pages" en="Workers & Pages" /> → <code>{DEFAULT_WORKER_NAME}</code>를 눌러요.
        </li>
        <li>주소를 복사해서 아래 칸에 붙여 넣어요.</li>
      </Steps>
      <Mock
        app="Cloudflare 대시보드"
        url="dash.cloudflare.com"
        menu={{ items: ["계정 홈", "Workers 및 Pages", "도메인"], active: 1 }}
        caption="Worker 화면 위쪽에 주소가 있어요(단순화한 그림)."
      >
        <MTitle>{DEFAULT_WORKER_NAME}</MTitle>
        <MField label="도메인 및 경로 (Domains & Routes)" value={`${DEFAULT_WORKER_NAME}.내하위도메인.workers.dev`} hl={1} />
        <MRow>
          <MButton label="개요" />
          <MButton label="설정 (Settings)" />
        </MRow>
      </Mock>
      <div class="field">
        <label for="su-url">내 나눔보드 주소</label>
        <input
          id="su-url"
          class="input"
          inputMode="url"
          autoComplete="off"
          spellcheck={false}
          placeholder="https://nanumboard.내이름.workers.dev"
          value={draft}
          aria-invalid={touched && !res.ok}
          aria-describedby="su-url-msg"
          onInput={(e) => {
            setDraft(e.currentTarget.value);
            setTouched(false);
            setSavedNote(null);
          }}
          onBlur={save}
          onKeyDown={(e) => e.key === "Enter" && save()}
        />
        <div id="su-url-msg" aria-live="polite">
          {touched && !res.ok && <div class="error-text">{res.error}</div>}
          {res.ok && (res.note || savedNote) && <div class="hint">{res.note ?? savedNote}</div>}
        </div>
        <div class="row">
          <button type="button" class="btn btn-primary" onClick={save}>
            주소 저장
          </button>
          {p.state.instanceUrl && <span class="chip chip-primary">저장됨: {p.state.instanceUrl}</span>}
        </div>
      </div>
      {p.derived && (
        <Callout kind="ok" title="주소가 열리는지 확인해 보세요">
          <p>
            <Ext href={p.derived.origin}>내 나눔보드 열어 보기</Ext> — ‘나눔보드’ 첫 화면이 나오면 설치 성공이에요.
          </p>
          <p>
            다음 단계부터는 <strong>내 나눔보드 안의 안내 페이지</strong>에서 이어 해도 돼요. 그쪽에서는 주소를 자동으로 알고, 마지막에 설치가 잘 됐는지 점검까지 해 줘요.
            (이 페이지에 적은 내용은 그쪽으로 옮겨 가지 않아요.)
          </p>
          <p>
            <a class="btn" href={p.derived.setupUrl}>
              내 나눔보드에서 이어 하기 →
            </a>
          </p>
        </Callout>
      )}
      <Stuck ids={["address", "build"]} ctx={p.ctx} />
    </>
  );
}

/* ───────────────────────── Google 설정 ───────────────────────── */

const GCP = "Google Cloud 콘솔";
const GCP_URL = "console.cloud.google.com";
const AUTH_MENU = ["개요", "브랜딩", "대상", "클라이언트", "데이터 액세스"];

function ProjectStep(p: StepProps) {
  return (
    <>
      <p>
        이제 Google 쪽 준비예요. <Term word="Google Cloud">Google이 개발자에게 주는 관리 화면</Term>에 나눔보드용 ‘프로젝트(설정 묶음)’를 하나 만들어요. 무료이고 카드
        등록이 필요 없어요.
      </p>
      <Steps>
        <li>
          {p.state.account === "school" ? "개인 Gmail 계정으로 " : ""}
          <Ext href={LINKS.gcpNewProject}>새 프로젝트 만들기 페이지</Ext>를 열어요. 처음이면 국가와 약관 동의 창이 먼저 나와요 → 동의하고 계속.
        </li>
        <li>
          <UI ko="프로젝트 이름" en="Project name" />에 <code>nanumboard</code>라고 적어요. <UI ko="위치" en="Location" />는 그대로 둬요.
        </li>
        <li>
          <UI ko="만들기" en="Create" />를 누르고 10초쯤 기다려요.
        </li>
        <li>
          화면 맨 위 프로젝트 선택 칸에 <strong>nanumboard</strong>가 보이는지 확인해요. 다른 이름이면 눌러서 nanumboard로 바꿔요.
        </li>
      </Steps>
      <Mock app={GCP} url={GCP_URL} caption="새 프로젝트 화면(단순화한 그림).">
        <MTitle>새 프로젝트 (New Project)</MTitle>
        <MField label="프로젝트 이름 (Project name)" value="nanumboard" hl={1} />
        <MField label="위치 (Location)" value="조직 없음 (No organization)" />
        <MRow end>
          <MButton label="만들기 (Create)" primary hl={2} />
        </MRow>
      </Mock>
      <Callout kind="info" title="이후 모든 Google 단계에서">
        화면 맨 위에 <strong>nanumboard</strong> 프로젝트가 골라져 있는지 꼭 확인하세요. 다른 프로젝트에 설정하면 동작하지 않아요.
      </Callout>
      <Stuck ids={["project", "school"]} ctx={p.ctx} />
    </>
  );
}

function DriveApiStep(p: StepProps) {
  return (
    <>
      <p>나눔보드가 선생님 드라이브에 사진·파일을 넣을 수 있도록 ‘Google Drive API’라는 기능을 켜요.</p>
      <Steps>
        <li>
          <Ext href={LINKS.gcpDriveApi}>Google Drive API 페이지</Ext>를 열어요. (위쪽 프로젝트가 nanumboard인지 확인!)
        </li>
        <li>
          파란 <UI ko="사용" en="Enable" /> 버튼을 눌러요. 이미 <UI ko="관리" en="Manage" />라고 보이면 켜져 있는 거예요.
        </li>
      </Steps>
      <Mock app={GCP} url={GCP_URL} caption="API 라이브러리의 Google Drive API 화면(단순화한 그림).">
        <MTitle>Google Drive API</MTitle>
        <MText>Google Drive에 있는 파일을 만들고 관리합니다.</MText>
        <MRow>
          <MButton label="사용 (Enable)" primary hl={1} />
          <MButton label="API 사용해 보기" />
        </MRow>
      </Mock>
      <Stuck ids={["api"]} ctx={p.ctx} />
    </>
  );
}

function ConsentStep(p: StepProps) {
  return (
    <>
      <p>
        선생님이 로그인할 때 보게 될 <Term word="동의 화면">“이 앱이 내 계정을 써도 될까요?”를 묻는 Google 화면</Term>의 기본 정보를 적어요.
      </p>
      <Steps>
        <li>
          <Ext href={LINKS.gcpAuthOverview}>Google 인증 플랫폼(Google Auth Platform)</Ext>을 열고 <UI ko="시작하기" en="Get started" />를
          눌러요.
        </li>
        <li>
          <strong>앱 정보</strong>: <UI ko="앱 이름" en="App name" />에 <code>나눔보드</code>, <UI ko="사용자 지원 이메일" en="User support email" />은 내 이메일을 골라요 →{" "}
          <UI ko="다음" en="Next" />
        </li>
        <li>
          <strong>대상</strong>: <UI ko="외부" en="External" />를 골라요 → <UI ko="다음" en="Next" />
          {p.state.account === "school" && <span class="hint"> (학교 계정으로 만들고 있다면 ‘내부’도 보일 수 있지만, 이 안내는 ‘외부’ 기준이에요.)</span>}
        </li>
        <li>
          <strong>연락처 정보</strong>: 내 이메일 주소 → <UI ko="다음" en="Next" />
        </li>
        <li>
          <strong>완료</strong>: Google API 서비스 사용자 데이터 정책 동의에 체크 → <UI ko="계속" en="Continue" /> → <UI ko="만들기" en="Create" />
        </li>
      </Steps>
      <Mock app={GCP} url={GCP_URL} caption="‘시작하기’를 누르면 나오는 4칸짜리 입력 화면(단순화한 그림).">
        <MTitle>프로젝트 구성 (Project configuration)</MTitle>
        <MField label="① 앱 정보 — 앱 이름 (App name)" value="나눔보드" hl={1} />
        <MChoice options={["내부 (Internal)", "외부 (External)"]} selected={1} hl={2} />
        <MField label="③ 연락처 정보 — 이메일 주소" value="내 이메일" />
        <MChoice options={["Google API 서비스: 사용자 데이터 정책에 동의합니다"]} selected={0} check hl={3} />
        <MRow end>
          <MButton label="만들기 (Create)" primary hl={4} />
        </MRow>
      </Mock>
      <CopyField label="앱 이름" value="나눔보드" />
      <Callout kind="warn" title="로고는 올리지 마세요">
        로고를 올리면 Google의 심사를 받아야 해요. 이름만 적으면 충분해요.
      </Callout>
      <Stuck ids={["project", "school"]} ctx={p.ctx} />
    </>
  );
}

function ScopesStep(p: StepProps) {
  return (
    <>
      <p>
        나눔보드가 Google에 부탁할 <Term word="권한 범위">앱이 할 수 있는 일의 목록</Term>을 적어요. 딱 세 가지만 넣어요. 그중 드라이브 권한은{" "}
        <strong>나눔보드가 만든 파일만</strong> 다룰 수 있는 가장 좁은 권한이라 선생님의 다른 드라이브 파일은 볼 수 없어요.
      </p>
      <Steps>
        <li>
          <Ext href={LINKS.gcpDataAccess}>데이터 액세스(Data Access) 화면</Ext>을 열어요.
        </li>
        <li>
          <UI ko="범위 추가 또는 삭제" en="Add or remove scopes" />를 눌러요.
        </li>
        <li>
          오른쪽에 열린 창 아래쪽 <UI ko="직접 범위 추가" en="Manually add scopes" /> 칸에 아래 값을 붙여 넣고 <UI ko="표에 추가" en="Add to table" />를 눌러요.
        </li>
        <li>
          표에서 세 줄이 체크됐는지 보고 <UI ko="업데이트" en="Update" /> → 화면 아래 <UI ko="저장" en="Save" />을 눌러요.
        </li>
      </Steps>
      <CopyField label="세 가지 범위 (한꺼번에 붙여 넣기)" value={SCOPES.map((s) => s.value).join("\n")} hint="한 번에 복사해서 붙여 넣어도 돼요." />
      <ul class="su-scope-list">
        {SCOPES.map((s) => (
          <li key={s.value}>
            <code>{s.value.replace("https://www.googleapis.com/auth/", "…/auth/")}</code> — {s.desc}
          </li>
        ))}
      </ul>
      <Mock app={GCP} url={GCP_URL} menu={{ items: AUTH_MENU, active: 4 }} caption="데이터 액세스 화면과 범위 추가 창(단순화한 그림).">
        <MTitle>데이터 액세스 (Data Access)</MTitle>
        <MButton label="범위 추가 또는 삭제" hl={1} />
        <MField label="직접 범위 추가 (Manually add scopes)" value="…/auth/drive.file" hl={2} />
        <MRow end>
          <MButton label="표에 추가" />
          <MButton label="업데이트 (Update)" primary hl={3} />
        </MRow>
      </Mock>
      <Callout kind="warn">다른 범위(예: 드라이브 전체)를 넣지 마세요. 넣으면 Google 심사가 필요해지고 로그인 때 경고 화면이 나와요.</Callout>
      <Stuck ids={["scope-list"]} ctx={p.ctx} />
    </>
  );
}

function PublishStep(p: StepProps) {
  return (
    <>
      <p>
        처음 만든 앱은 ‘테스트 중’ 상태예요. 이대로 두면 <strong>7일마다 드라이브 연결이 끊겨요.</strong> ‘프로덕션(정식 사용)’으로 바꿔 주세요. 나눔보드가 쓰는 권한은
        좁은 권한뿐이라 Google 심사 없이 바로 바뀌어요.
      </p>
      <Steps>
        <li>
          <Ext href={LINKS.gcpAudience}>대상(Audience) 화면</Ext>을 열어요.
        </li>
        <li>
          <UI ko="게시 상태" en="Publishing status" />가 <UI ko="테스트 중" en="Testing" />이면 <UI ko="앱 게시" en="Publish app" />를 눌러요.
        </li>
        <li>
          확인 창에서 <UI ko="확인" en="Confirm" />을 눌러요. 상태가 <UI ko="프로덕션 단계" en="In production" />로 바뀌면 끝!
        </li>
      </Steps>
      <Mock app={GCP} url={GCP_URL} menu={{ items: AUTH_MENU, active: 2 }} caption="대상 화면(단순화한 그림).">
        <MTitle>대상 (Audience)</MTitle>
        <MField label="게시 상태 (Publishing status)" value="테스트 중 (Testing)" />
        <MButton label="앱 게시 (Publish app)" primary hl={1} />
        <MField label="사용자 유형 (User type)" value="외부 (External)" />
      </Mock>
      <Callout kind="info">‘테스트 사용자’는 추가하지 않아도 돼요. 프로덕션이면 필요 없어요.</Callout>
      <Stuck ids={["7days", "unverified"]} ctx={p.ctx} />
    </>
  );
}

function ClientStep(p: StepProps) {
  const d = p.derived;
  return (
    <>
      <p>
        나눔보드가 Google에 “저 나눔보드예요” 하고 알릴 때 쓰는 <Term word="OAuth 클라이언트">나눔보드 전용 출입증</Term>을 만들어요. 아이디(클라이언트 ID)와 비밀번호(보안
        비밀번호) 한 쌍이 나와요.
      </p>
      {!d && <NeedAddress {...p} />}
      <Steps>
        <li>
          <Ext href={LINKS.gcpClients}>클라이언트(Clients) 화면</Ext>을 열고 <UI ko="클라이언트 만들기" en="Create client" />를 눌러요.
        </li>
        <li>
          <UI ko="애플리케이션 유형" en="Application type" />: <UI ko="웹 애플리케이션" en="Web application" />
        </li>
        <li>
          <UI ko="이름" en="Name" />: <code>나눔보드</code> (아무 이름이나 괜찮아요)
        </li>
        <li>
          <UI ko="승인된 리디렉션 URI" en="Authorized redirect URIs" /> 아래 <UI ko="URI 추가" en="Add URI" />를 누르고, 아래 값을 <strong>그대로</strong> 붙여 넣어요.
        </li>
        <li>
          <UI ko="만들기" en="Create" />를 눌러요.
        </li>
      </Steps>
      {d && (
        <>
          <CopyField label="승인된 리디렉션 URI (꼭 넣기)" value={d.redirectUri} big hint="복사 버튼으로 복사하세요. 끝에 / 나 띄어쓰기를 붙이지 마세요." />
          <CopyField
            label="승인된 자바스크립트 원본 (선택)"
            value={d.jsOrigin}
            hint="이 칸은 비워 둬도 돼요. 넣고 싶다면 이 값을 넣으세요(끝에 / 없이)."
          />
        </>
      )}
      <Mock app={GCP} url={GCP_URL} menu={{ items: AUTH_MENU, active: 3 }} caption="클라이언트 만들기 화면(단순화한 그림).">
        <MTitle>OAuth 클라이언트 ID 만들기</MTitle>
        <MField label="애플리케이션 유형 (Application type)" value="웹 애플리케이션 (Web application)" hl={1} />
        <MField label="이름 (Name)" value="나눔보드" />
        <MField label="승인된 자바스크립트 원본 — 선택" placeholder="비워 둬도 돼요" />
        <MField label="승인된 리디렉션 URI (Authorized redirect URIs)" value={d ? d.redirectUri : "https://…workers.dev/auth/google/callback"} hl={2} />
        <MRow end>
          <MButton label="만들기 (Create)" primary hl={3} />
        </MRow>
      </Mock>
      <Callout kind="danger" title="만들기를 누른 뒤 나오는 창을 바로 닫지 마세요!">
        <p>
          창에 <strong>클라이언트 ID</strong>와 <strong>클라이언트 보안 비밀번호</strong>가 나와요. 보안 비밀번호는 <strong>이때 한 번만</strong> 보여요.{" "}
          <UI ko="JSON 다운로드" en="Download JSON" />를 눌러 파일로 저장해 두거나, 이 창을 열어 둔 채로 다음 두 단계를 진행하세요.
        </p>
      </Callout>
      <Mock app={GCP} url={GCP_URL} caption="클라이언트를 만든 직후 나오는 창(단순화한 그림).">
        <MTitle>OAuth 클라이언트 생성됨</MTitle>
        <MField label="클라이언트 ID (Client ID)" value="123456789-abc….apps.googleusercontent.com" hl={1} />
        <MField label="클라이언트 보안 비밀번호 (Client secret)" value="GOCSPX-••••••••" hl={2} />
        <MRow end>
          <MButton label="JSON 다운로드" hl={3} />
          <MButton label="확인 (OK)" />
        </MRow>
      </Mock>
      <Stuck ids={["redirect", "secret-lost"]} ctx={p.ctx} />
    </>
  );
}

function ClientIdStep(p: StepProps) {
  const [draft, setDraft] = useState(p.state.clientId);
  const [touched, setTouched] = useState(false);
  const [secretWarn, setSecretWarn] = useState(false);
  const res = checkClientId(draft);
  const save = () => {
    setTouched(true);
    if (res.ok) p.update({ clientId: res.value });
  };
  return (
    <>
      <p>
        방금 나온 창에서 <strong>클라이언트 ID만</strong> 복사해서 아래에 붙여 넣어 주세요. 다음 단계에서 Cloudflare에 넣기 좋게 정리해 드릴게요.
      </p>
      <Callout kind="danger" title="보안 비밀번호는 여기에 넣지 마세요">
        <code>GOCSPX-</code>로 시작하는 <strong>보안 비밀번호</strong>는 이 페이지 어디에도 넣지 않아요. 다음 단계에서 Cloudflare에만 바로 붙여 넣어요.
      </Callout>
      <div class="field">
        <label for="su-cid">클라이언트 ID</label>
        <input
          id="su-cid"
          class="input"
          autoComplete="off"
          spellcheck={false}
          placeholder="123456789-abcdef….apps.googleusercontent.com"
          value={draft}
          aria-invalid={touched && !res.ok}
          aria-describedby="su-cid-msg"
          onInput={(e) => {
            const v = e.currentTarget.value;
            if (looksLikeClientSecret(v)) {
              // 비밀번호를 붙여 넣었으면 저장도 화면 표시도 하지 않고 바로 지운다.
              setDraft("");
              e.currentTarget.value = "";
              setSecretWarn(true);
              setTouched(false);
              return;
            }
            setSecretWarn(false);
            setDraft(v);
            setTouched(false);
          }}
          onBlur={save}
          onKeyDown={(e) => e.key === "Enter" && save()}
        />
        <div id="su-cid-msg" aria-live="polite">
          {secretWarn && (
            <div class="error-text">
              방금 붙여 넣은 건 ‘클라이언트 보안 비밀번호’예요. 저장하지 않고 지웠어요. 여기에는 <strong>클라이언트 ID</strong>(끝이 .apps.googleusercontent.com)를 넣어 주세요.
            </div>
          )}
          {touched && !res.ok && !secretWarn && <div class="error-text">{res.error}</div>}
        </div>
        <div class="row">
          <button type="button" class="btn btn-primary" onClick={save}>
            클라이언트 ID 저장
          </button>
          {p.state.clientId && <span class="chip chip-primary">저장됨 ✓</span>}
        </div>
      </div>
      <Stuck ids={["secret-lost"]} ctx={p.ctx} />
    </>
  );
}

/* ───────────────────────── 연결 ───────────────────────── */

function KeysStep(p: StepProps) {
  const [emailDraft, setEmailDraft] = useState(p.state.ownerEmail);
  const [emailTouched, setEmailTouched] = useState(false);
  const email = checkEmail(emailDraft);
  const name = p.derived?.workerName ?? DEFAULT_WORKER_NAME;
  return (
    <>
      <p>
        이제 Google에서 받은 출입증을 Cloudflare의 나눔보드에 넣어요. Cloudflare에서는 이걸 <Term word="변수 및 비밀">나눔보드만 읽을 수 있는 설정값</Term>이라고 불러요.
      </p>
      <Steps>
        <li>
          <Ext href={LINKS.cloudflareWorkers}>Cloudflare 대시보드</Ext> → <UI ko="Workers 및 Pages" en="Workers & Pages" /> → <code>{name}</code>를 눌러요.
        </li>
        <li>
          <UI ko="설정" en="Settings" /> 탭 → <UI ko="변수 및 비밀" en="Variables and Secrets" /> 옆 <UI ko="추가" en="Add" />를 눌러요.
        </li>
        <li>
          아래 표대로 하나씩 넣어요. <UI ko="유형" en="Type" />은 모두 <UI ko="비밀" en="Secret" />로 골라요. 두 번째부터는 <UI ko="변수 추가" en="Add variable" />를 눌러 줄을
          늘려요.
        </li>
        <li>
          다 넣었으면 <UI ko="배포" en="Deploy" />를 눌러요. 이걸 눌러야 적용돼요.
        </li>
      </Steps>
      <div class="su-keys">
        <div class="su-key">
          <div class="su-key-head">
            <span class="chip">1</span> 유형: 비밀
          </div>
          <CopyField label="변수 이름" value="GOOGLE_CLIENT_ID" />
          {p.state.clientId ? (
            <CopyField label="값 (클라이언트 ID)" value={p.state.clientId} />
          ) : (
            <p class="hint">
              값: 클라이언트 ID.{" "}
              <button type="button" class="btn btn-small" onClick={() => p.ctx.goStep("clientid")}>
                클라이언트 ID 넣으러 가기
              </button>
            </p>
          )}
        </div>
        <div class="su-key">
          <div class="su-key-head">
            <span class="chip">2</span> 유형: 비밀
          </div>
          <CopyField label="변수 이름" value="GOOGLE_CLIENT_SECRET" />
          <p class="su-key-secret">
            값: Google 창(또는 내려받은 JSON 파일의 <code>client_secret</code>)에 있는 <strong>보안 비밀번호</strong>를 직접 복사해서 Cloudflare에 바로 붙여 넣어요. 이 안내
            페이지는 비밀번호를 보지도 저장하지도 않아요.
          </p>
        </div>
        <details class="su-key su-key-optional">
          <summary>
            <span class="chip">3</span> 선택: 주인 계정 못 박기 (OWNER_EMAIL)
          </summary>
          <p class="hint">
            나눔보드는 <strong>처음 로그인한 Google 계정</strong>을 주인으로 정해요. 혹시 다른 사람이 먼저 로그인하는 일을 막고 싶다면 내 Google 계정 이메일을 넣어 두세요.
            안 넣어도 괜찮아요.
          </p>
          <div class="field">
            <label for="su-email">주인이 될 Google 계정 이메일</label>
            <input
              id="su-email"
              class="input"
              type="email"
              autoComplete="email"
              placeholder="teacher@gmail.com"
              value={emailDraft}
              aria-invalid={emailTouched && !email.ok}
              onInput={(e) => {
                setEmailDraft(e.currentTarget.value);
                setEmailTouched(false);
              }}
              onBlur={() => {
                setEmailTouched(true);
                if (email.ok) p.update({ ownerEmail: email.value });
                else if (!emailDraft.trim()) p.update({ ownerEmail: "" });
              }}
            />
            {emailTouched && !email.ok && emailDraft.trim() && <div class="error-text">{email.error}</div>}
          </div>
          <CopyField label="변수 이름" value="OWNER_EMAIL" />
          {p.state.ownerEmail && <CopyField label="값" value={p.state.ownerEmail} />}
        </details>
      </div>
      <Mock
        app="Cloudflare 대시보드"
        url="dash.cloudflare.com"
        menu={{ items: ["개요", "배포", "설정"], active: 2 }}
        caption="Worker → 설정 → 변수 및 비밀 → 추가 를 누르면 나오는 칸(단순화한 그림)."
      >
        <MTitle>변수 및 비밀 (Variables and Secrets)</MTitle>
        <MRow>
          <MField label="유형 (Type)" value="비밀 (Secret)" hl={1} />
        </MRow>
        <MField label="변수 이름 (Variable name)" value="GOOGLE_CLIENT_ID" hl={2} />
        <MField label="값 (Value)" value="123456789-abc….apps.googleusercontent.com" />
        <MRow end>
          <MButton label="+ 변수 추가" />
          <MButton label="배포 (Deploy)" primary hl={3} />
        </MRow>
      </Mock>
      <Callout kind="info" title="왜 모두 ‘비밀’로 넣나요?">
        ‘비밀’로 넣은 값은 나중에 나눔보드를 업데이트해도 지워지지 않고, 화면에도 다시 보이지 않아 안전해요.
      </Callout>
      <Stuck ids={["not-configured", "secret", "secret-lost"]} ctx={p.ctx} />
    </>
  );
}

function LoginStep(p: StepProps) {
  const d = p.derived;
  return (
    <>
      <p>
        마지막이에요! 내 나눔보드에 Google 계정으로 처음 로그인하면 그 계정이 <strong>이 나눔보드의 주인(선생님)</strong>이 돼요.
      </p>
      {!d && <NeedAddress {...p} />}
      <Steps>
        <li>
          {d ? (
            <a class="btn btn-primary" href={d.loginUrl} target={p.mode === "instance" ? undefined : "_blank"} rel="noopener">
              Google로 로그인
            </a>
          ) : (
            "내 나눔보드 주소를 열고 ‘Google로 로그인’"
          )}{" "}
          을 눌러요.
        </li>
        <li>
          계정 고르는 화면에서 <strong>학생 파일을 저장할 Google 계정</strong>을 골라요.
        </li>
        <li>
          “Google에서 확인하지 않은 앱” 화면이 나오면 <UI ko="고급" en="Advanced" /> → <UI ko="이동" en="Go to …" />을 눌러요(선생님이 만든 앱이라 괜찮아요).
        </li>
        <li>
          권한을 묻는 화면에서 <strong>Google Drive 항목의 체크 칸을 꼭 켜고</strong> <UI ko="계속" en="Continue" />을 눌러요.
        </li>
        <li>선생님 화면이 나오면 성공이에요.</li>
      </Steps>
      <Mock app="Google 로그인" url="accounts.google.com" caption="권한을 묻는 화면(단순화한 그림). 드라이브 항목 체크가 꼭 필요해요.">
        <MTitle>…workers.dev에서 Google 계정에 대한 추가 액세스를 요청합니다</MTitle>
        <MChoice options={["모두 선택 (Select all)"]} selected={0} check />
        <MChoice options={["Google Drive 파일 중 이 앱에서 사용하는 파일만 보기, 수정, 생성, 삭제"]} selected={0} check hl={1} />
        <MRow end>
          <MButton label="취소" />
          <MButton label="계속 (Continue)" primary hl={2} />
        </MRow>
      </Mock>
      <Stuck ids={["redirect", "access-denied", "unverified", "scope", "not-configured", "secret", "owner", "school"]} ctx={p.ctx} />
    </>
  );
}

function CheckStep(p: StepProps) {
  if (p.mode === "instance") return <LiveCheck ctx={p.ctx} />;
  const d = p.derived;
  return (
    <>
      <p>
        설치 점검은 <strong>내 나눔보드 안의 안내 페이지</strong>에서 할 수 있어요. 거기서 Google 설정, 주인 계정, 드라이브 연결을 하나씩 확인해서 초록색/빨간색으로 보여
        줘요.
      </p>
      {d ? (
        <p>
          <a class="btn btn-primary" href={d.checkUrl}>
            내 나눔보드에서 설치 점검하기 →
          </a>
        </p>
      ) : (
        <NeedAddress {...p} />
      )}
    </>
  );
}

export const STEPS: StepDef[] = [
  { id: "start", group: "준비", title: "시작하기", minutes: 2, render: StartStep },
  { id: "github", group: "준비", title: "GitHub 가입", minutes: 3, render: GithubStep },
  { id: "cloudflare", group: "준비", title: "Cloudflare 가입", minutes: 3, render: CloudflareStep },
  { id: "deploy", group: "설치", title: "설치 버튼 누르기", minutes: 5, render: DeployStep },
  {
    id: "address",
    group: "설치",
    title: "내 나눔보드 주소 확인",
    minutes: 2,
    render: AddressStep,
    blocker: (p) => (p.derived ? null : "주소를 저장해야 다음 단계에서 정확한 값을 만들어 드릴 수 있어요."),
  },
  { id: "gproject", group: "Google 설정", title: "Google Cloud 프로젝트 만들기", minutes: 3, render: ProjectStep },
  { id: "driveapi", group: "Google 설정", title: "Google Drive API 켜기", minutes: 1, render: DriveApiStep },
  { id: "consent", group: "Google 설정", title: "로그인 화면 정보 적기", minutes: 4, render: ConsentStep },
  { id: "scopes", group: "Google 설정", title: "권한 범위 3개 넣기", minutes: 3, render: ScopesStep },
  { id: "publish", group: "Google 설정", title: "앱 게시 (프로덕션)", minutes: 1, render: PublishStep },
  { id: "client", group: "Google 설정", title: "OAuth 클라이언트 만들기", minutes: 4, render: ClientStep },
  {
    id: "clientid",
    group: "Google 설정",
    title: "클라이언트 ID 붙여 넣기",
    minutes: 1,
    render: ClientIdStep,
    blocker: (p) => (p.state.clientId ? null : "클라이언트 ID를 저장하면 다음 단계에서 복사하기 쉽게 보여 드려요."),
  },
  { id: "keys", group: "연결", title: "Cloudflare에 넣기", minutes: 4, render: KeysStep },
  { id: "login", group: "연결", title: "첫 로그인", minutes: 2, render: LoginStep },
  { id: "check", group: "연결", title: "설치 점검", minutes: 1, render: CheckStep },
];
