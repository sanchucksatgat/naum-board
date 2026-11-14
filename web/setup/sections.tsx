import { LINKS, SOURCE_REPO_URL } from "./config";
import { Callout, Ext, Steps, UI } from "./ui";

/** 업데이트하는 법 */
export function UpdateSection() {
  return (
    <>
      <p>
        업데이트는 <strong>꼭 하지 않아도 돼요.</strong> 설치한 나눔보드는 그대로 계속 쓸 수 있어요. 새 기능이 나왔을 때만 아래처럼 하면 되고, 학생 글과 보드는 그대로
        남아요.
      </p>
      <h4>처음 한 번만: 업데이트 통로 만들기 (약 5분)</h4>
      <p class="hint">
        설치 버튼은 프로그램을 ‘복사’해서 만들기 때문에 원본과 연결되어 있지 않아요. 그래서 처음 한 번만 원본과 연결된 사본(Fork, 갈래)을 만들어 나눔보드에 이어
        줘요.
      </p>
      <Steps>
        <li>
          GitHub에 로그인한 채로 <Ext href={SOURCE_REPO_URL}>나눔보드 원본 저장소</Ext>를 열고 오른쪽 위 <UI ko="Fork" /> → <UI ko="Create fork" />를 눌러요. 이름이 이미
          있다고 나오면 <code>nanumboard-update</code>처럼 바꿔요.
        </li>
        <li>
          <Ext href={LINKS.cloudflareWorkers}>Cloudflare 대시보드</Ext> → <UI ko="Workers 및 Pages" en="Workers & Pages" /> → 나눔보드 → <UI ko="설정" en="Settings" /> →{" "}
          <UI ko="빌드" en="Build" />로 가요.
        </li>
        <li>
          연결된 Git 저장소 옆 <UI ko="연결 끊기" en="Disconnect" />를 누른 뒤, <UI ko="연결" en="Connect" />을 눌러 방금 만든 Fork를 골라요.
        </li>
        <li>
          분기(branch)는 <code>main</code>, <UI ko="배포 명령" en="Deploy command" />은 <code>npm run deploy</code>로 적고 저장해요. 몇 분 뒤 새 버전이 설치돼요.
        </li>
      </Steps>
      <h4>그다음부터: 버튼 두 번</h4>
      <Steps>
        <li>GitHub에서 내 Fork 저장소를 열어요.</li>
        <li>
          <UI ko="Sync fork" /> → <UI ko="Update branch" />를 눌러요. 2~3분 뒤 Cloudflare가 알아서 새 버전을 설치해요.
        </li>
      </Steps>
      <Callout kind="info">
        Cloudflare에 넣은 GOOGLE_CLIENT_ID 같은 값은 ‘비밀’로 넣었기 때문에 업데이트해도 지워지지 않아요. Google 설정도 다시 할 필요 없어요.
      </Callout>
    </>
  );
}

/** 비용 */
export function CostSection() {
  return (
    <>
      <p>
        <strong>들지 않아요.</strong> 세 곳 모두 무료 요금제로 충분하고, 카드를 등록하지 않으니 저절로 돈이 나가는 일도 없어요.
      </p>
      <table class="su-table">
        <thead>
          <tr>
            <th scope="col">어디</th>
            <th scope="col">무료로 쓰는 만큼</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <th scope="row">Cloudflare</th>
            <td>
              나눔보드에 오는 요청 하루 10만 번, 보드 저장소 요청 하루 10만 번 등. 한 반 학생 50명이 한 시간 내내 써도 한참 남아요. 화면 자체(그림·글꼴 등)를 불러오는 건 횟수에
              들어가지 않아요.
            </td>
          </tr>
          <tr>
            <th scope="row">Google</th>
            <td>
              Drive API는 무료예요. 사진·파일은 선생님 드라이브 용량(무료 계정은 Gmail·사진과 합쳐 15GB)을 써요. 사진은 올리기 전에 자동으로 줄여서 올라가요.
            </td>
          </tr>
          <tr>
            <th scope="row">GitHub</th>
            <td>무료예요. 설치·업데이트 때 Cloudflare가 프로그램을 만드는 시간도 무료 한도(한 달 3,000분) 안이에요. 한 번에 1~2분 걸려요.</td>
          </tr>
        </tbody>
      </table>
      <Callout kind="info" title="혹시 한도를 넘으면?">
        돈이 청구되지 않고, 그날 남은 시간 동안 일부 기능에 오류가 나요. 한도는 매일 오전 9시(한국 시간)에 다시 채워져요.
      </Callout>
    </>
  );
}

/** 개인정보 */
export function PrivacySection() {
  return (
    <>
      <p>
        학생 정보는 <strong>모두 선생님 계정 안에만</strong> 저장돼요. 나눔보드를 만든 사람들에게는 어떤 정보도 보내지지 않아요. 나눔보드는 선생님 Cloudflare 계정에서
        선생님 것으로 돌아가는 프로그램이에요.
      </p>
      <table class="su-table">
        <thead>
          <tr>
            <th scope="col">무엇</th>
            <th scope="col">어디에</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <th scope="row">글·댓글·좋아요·공지, 명단(학번·이름)</th>
            <td>선생님 Cloudflare 계정 안의 저장소(보드마다 하나씩 있는 작은 데이터베이스). 학생 PIN은 알아볼 수 없게 바꿔서(해시) 저장해요.</td>
          </tr>
          <tr>
            <th scope="row">사진·첨부 파일, 글 백업 파일</th>
            <td>
              선생님 Google 드라이브의 <code>나눔보드</code> 폴더. 링크 공유(공개)를 하지 않고, 나눔보드를 거쳐서만 보여요.
            </td>
          </tr>
          <tr>
            <th scope="row">GitHub 사본</th>
            <td>프로그램 코드만 있어요. 학생 정보는 없어요.</td>
          </tr>
        </tbody>
      </table>
      <ul>
        <li>학생은 Google 로그인을 하지 않아요. 입장 코드와 학번·PIN(또는 닉네임)으로만 들어와요.</li>
        <li>나눔보드가 볼 수 있는 드라이브 파일은 나눔보드가 직접 만든 파일뿐이에요. 선생님의 다른 드라이브 파일은 볼 수 없어요.</li>
        <li>
          Cloudflare와 Google은 서버를 해외에도 둔 회사예요. 학교나 교육청의 개인정보 처리 지침이 있다면 함께 확인해 주세요. 실명 대신 닉네임 입장이나 익명 모드를 쓰면
          더 안심할 수 있어요.
        </li>
      </ul>
    </>
  );
}
