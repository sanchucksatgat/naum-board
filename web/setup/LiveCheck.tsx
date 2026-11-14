import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { MeResponse, SetupDriveCheck } from "../../src/shared/api";
import { fetchMe } from "../lib/api";
import type { HelpCtx } from "./help";

type Status = "ok" | "bad" | "wait" | "todo";

interface Item {
  key: string;
  status: Status;
  label: string;
  detail?: ComponentChildren;
}

async function fetchDriveCheck(): Promise<SetupDriveCheck> {
  const res = await fetch("/api/setup/drive-check", { credentials: "same-origin" });
  if (!res.ok) throw new Error(`drive-check ${res.status}`);
  return (await res.json()) as SetupDriveCheck;
}

function HelpLink(props: { id: string; children: ComponentChildren }) {
  return (
    <a href={`#help-${props.id}`} class="su-check-help">
      {props.children}
    </a>
  );
}

/** 설치된 나눔보드 안에서만 쓰는 실시간 점검 목록 (/api/me + Drive 확인) */
/** onResult: 점검이 끝날 때마다 모두 통과했는지 알려 준다 (진행 막대의 마지막 단계 완료 표시용) */
export function LiveCheck(props: { ctx: HelpCtx; onResult?: (allOk: boolean) => void }) {
  const [me, setMe] = useState<MeResponse | null>(null);
  const [drive, setDrive] = useState<SetupDriveCheck | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);

  const run = async () => {
    setLoading(true);
    setError(false);
    setDrive(null);
    try {
      const m = await fetchMe();
      setMe(m);
      if (m.authenticated && m.drive?.status === "ok") {
        try {
          setDrive(await fetchDriveCheck());
        } catch {
          setDrive({ ok: false, code: "unavailable", message: "드라이브를 확인하지 못했어요. 잠시 뒤 다시 점검해 주세요." });
        }
      }
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void run();
  }, []);

  const go = (id: string) => (
    <button type="button" class="btn btn-small" onClick={() => props.ctx.goStep(id)}>
      해당 단계 보기
    </button>
  );
  const login = (label = "Google로 로그인") => (
    <a class="btn btn-small btn-primary" href="/auth/google">
      {label}
    </a>
  );

  const items: Item[] = [];
  if (me) {
    const s = me.setup;
    items.push({ key: "installed", status: "ok", label: "나눔보드가 설치되어 있어요" });
    items.push(
      s.googleConfigured
        ? { key: "google", status: "ok", label: "Google 로그인 설정(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET)이 들어가 있어요" }
        : {
            key: "google",
            status: "bad",
            label: "Google 로그인 설정이 아직 없어요",
            detail: (
              <>
                Cloudflare의 <strong>변수 및 비밀</strong>에 GOOGLE_CLIENT_ID와 GOOGLE_CLIENT_SECRET을 넣고 <strong>배포</strong>를 눌러 주세요. 넣었다면 1분쯤 뒤 다시
                점검해 보세요. {go("keys")} <HelpLink id="not-configured">도움말</HelpLink>
              </>
            ),
          },
    );
    if (!s.googleConfigured) {
      items.push({ key: "owner", status: "todo", label: "선생님 계정 연결 — Google 설정을 마친 뒤에 할 수 있어요" });
    } else if (!s.ownerClaimed) {
      items.push({
        key: "owner",
        status: "bad",
        label: "아직 선생님(주인) 계정이 연결되지 않았어요",
        detail: (
          <>
            처음 로그인하는 Google 계정이 주인이 돼요. 학생 파일을 저장할 계정으로 로그인하세요. 권한 화면에서 <strong>드라이브 체크 칸을 꼭 켜세요.</strong> {login()}
          </>
        ),
      });
    } else {
      items.push({ key: "owner", status: "ok", label: "선생님(주인) 계정이 연결되어 있어요" });
      if (!me.authenticated) {
        items.push({
          key: "auth",
          status: "todo",
          label: "이 브라우저에서는 로그인하지 않았어요",
          detail: (
            <>
              로그인하면 드라이브 연결까지 점검할 수 있어요. {login()} 다른 계정이 주인으로 등록됐다면 <HelpLink id="owner">주인 바꾸는 법</HelpLink>을 보세요.
            </>
          ),
        });
      } else {
        items.push({ key: "auth", status: "ok", label: `${me.teacher?.email ?? "선생님 계정"}으로 로그인되어 있어요` });
        const ds = me.drive?.status;
        if (ds === "ok") items.push({ key: "scope", status: "ok", label: "드라이브 권한을 받았어요" });
        else if (ds === "missing_scope")
          items.push({
            key: "scope",
            status: "bad",
            label: "드라이브 권한이 빠졌어요 (동의 화면에서 드라이브 체크를 안 했어요)",
            detail: (
              <>
                다시 로그인하면서 드라이브 체크 칸을 켜 주세요. {login("다시 로그인")} <HelpLink id="scope">도움말</HelpLink>
              </>
            ),
          });
        else if (ds === "reconnect_required")
          items.push({
            key: "scope",
            status: "bad",
            label: "드라이브 연결이 끊겼어요",
            detail: (
              <>
                앱이 아직 ‘테스트 중’이면 7일마다 끊겨요. 앱을 게시(프로덕션)한 다음 다시 로그인해 주세요. {login("다시 로그인")} {go("publish")}{" "}
                <HelpLink id="7days">도움말</HelpLink>
              </>
            ),
          });
        else
          items.push({
            key: "scope",
            status: "bad",
            label: "Google과 잠시 연결되지 않아요",
            detail: <>잠시 뒤 다시 점검해 주세요. 계속 이러면 Cloudflare의 보안 비밀번호가 맞는지 확인해 주세요. <HelpLink id="secret">도움말</HelpLink></>,
          });
        if (ds === "ok") {
          if (!drive) items.push({ key: "api", status: "wait", label: "드라이브에 실제로 접근해 보는 중…" });
          else if (drive.ok) items.push({ key: "api", status: "ok", label: "드라이브에 파일을 만들 수 있어요 (Google Drive API 켜짐)" });
          else if (drive.code === "api_disabled")
            items.push({
              key: "api",
              status: "bad",
              label: "Google Drive API가 꺼져 있어요",
              detail: (
                <>
                  nanumboard 프로젝트에서 Google Drive API를 <strong>사용</strong>으로 바꿔 주세요. {go("driveapi")} <HelpLink id="api">도움말</HelpLink>
                </>
              ),
            });
          else items.push({ key: "api", status: "bad", label: "드라이브를 확인하지 못했어요", detail: drive.message });
        }
      }
    }
  }

  const allOk = me !== null && items.length > 0 && items.every((i) => i.status === "ok");
  useEffect(() => {
    if (!loading && me) props.onResult?.(allOk);
  }, [loading, allOk]);
  const icon: Record<Status, string> = { ok: "✓", bad: "!", wait: "…", todo: "·" };
  const statusText: Record<Status, string> = { ok: "완료", bad: "확인 필요", wait: "확인 중", todo: "아직" };

  return (
    <div class="su-check" id="check">
      <div class="row">
        <p class="muted" style={{ margin: 0, flex: 1 }}>
          이 나눔보드(<code>{location.host}</code>)의 설치 상태를 실제로 확인해요.
        </p>
        <button type="button" class="btn btn-small" onClick={() => void run()} disabled={loading}>
          {loading ? "점검 중…" : "다시 점검"}
        </button>
      </div>
      {error && <p class="error-text">상태를 불러오지 못했어요. 인터넷 연결을 확인하고 다시 점검해 주세요.</p>}
      <ul class="su-check-list" aria-busy={loading}>
        {items.map((i) => (
          <li key={i.key} class={`su-check-item su-check-${i.status}`}>
            <span class="su-check-icon" aria-hidden="true">
              {icon[i.status]}
            </span>
            <div>
              <div class="su-check-label">
                <span class="sr-only">{statusText[i.status]}: </span>
                {i.label}
              </div>
              {i.detail && <div class="su-check-detail">{i.detail}</div>}
            </div>
          </li>
        ))}
      </ul>
      {me && (
        <div class="su-check-manual">
          <strong>직접 한 번 확인해 주세요</strong> — Google 인증 플랫폼 → 대상에서 게시 상태가 <strong>프로덕션 단계</strong>인가요? (이건 나눔보드가 알 수 없어요. ‘테스트
          중’이면 7일 뒤 연결이 끊겨요.)
        </div>
      )}
      {allOk && (
        <div class="su-done">
          <div class="su-done-title">설치가 모두 끝났어요!</div>
          <p>이제 선생님 화면에서 첫 보드를 만들어 보세요.</p>
          <a class="btn btn-primary" href="/teacher">
            선생님 화면으로 가기 →
          </a>
        </div>
      )}
    </div>
  );
}
