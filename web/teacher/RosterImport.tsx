/** 명단 넣기: 붙여넣기 또는 CSV 파일 → 미리보기(줄마다 오류) → 저장 */
import { useMemo, useState } from "preact/hooks";
import type { StudentRowInput } from "../../src/shared/protocol";
import { parseRoster, sampleRosterCsv, type RosterField } from "./roster";
import { downloadText } from "./ui";

const FIELD_LABEL: Record<RosterField, string> = { number: "학번", name: "이름", pin: "PIN", group: "모둠", nickname: "닉네임" };

export function RosterImport(props: { existingNumbers?: string[]; onChange: (valid: StudentRowInput[], ready: boolean) => void; idPrefix?: string }) {
  const id = props.idPrefix ?? "ri";
  const [text, setText] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const result = useMemo(() => (text.trim() ? parseRoster(text, { existingNumbers: props.existingNumbers }) : null), [text, props.existingNumbers]);

  const update = (t: string) => {
    setText(t);
    const r = t.trim() ? parseRoster(t, { existingNumbers: props.existingNumbers }) : null;
    props.onChange(r?.valid ?? [], !!r && r.problems.length === 0 && r.errorCount === 0 && r.valid.length > 0);
  };

  const onFile = async (file: File | undefined) => {
    setFileError(null);
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) return setFileError("파일이 너무 커요. 2MB 이하의 CSV 파일을 골라 주세요.");
    if (/\.xlsx?$/i.test(file.name)) return setFileError("엑셀 파일(.xlsx)은 바로 읽을 수 없어요. 엑셀에서 표를 복사해 아래 칸에 붙여 넣거나, ‘CSV UTF-8’로 저장해 주세요.");
    const buf = await file.arrayBuffer();
    let t = new TextDecoder("utf-8").decode(buf);
    // 한글 윈도우 엑셀의 기본 CSV(EUC-KR) 대비: UTF-8 로 깨지면 euc-kr 로 다시 읽는다
    if (t.includes("�")) {
      try {
        t = new TextDecoder("euc-kr").decode(buf);
      } catch {
        /* 지원 안 하는 브라우저 */
      }
    }
    setFileName(file.name);
    update(t);
  };

  return (
    <div class="stack">
      <div class="field">
        <label for={`${id}-text`}>학생 명단 붙여넣기</label>
        <textarea
          id={`${id}-text`}
          class="textarea t-mono"
          rows={6}
          value={text}
          placeholder={"엑셀·구글 시트에서 표를 복사해 붙여 넣어요.\n학번, 이름, 모둠 순서 예:\n20301\t김하나\t1모둠\n20302\t이두리\t1모둠"}
          onInput={(e) => {
            setFileName(null);
            update(e.currentTarget.value);
          }}
        />
        <p class="hint">한 줄에 한 명. 학번과 이름은 꼭 필요하고, PIN·모둠·닉네임은 없어도 돼요. PIN을 비우면 자동으로 4자리를 만들어요.</p>
      </div>
      <div class="row">
        <label class="btn btn-small t-file">
          CSV 파일 고르기
          <input type="file" accept=".csv,.tsv,.txt,text/csv,text/plain" class="sr-only" onChange={(e) => {
              const input = e.currentTarget;
              const file = input.files?.[0];
              // 같은 파일을 고친 뒤 다시 골라도 읽히게 비워 둔다
              input.value = "";
              void onFile(file);
            }}
          />
        </label>
        <button type="button" class="btn btn-small btn-ghost" onClick={() => downloadText("학생명단_예시.csv", sampleRosterCsv())}>
          예시 CSV 내려받기
        </button>
        {fileName && <span class="hint">불러온 파일: {fileName}</span>}
      </div>
      {fileError && (
        <p class="error-text" role="alert">
          {fileError}
        </p>
      )}

      {result && (
        <div class="stack t-preview" aria-live="polite">
          <p class="t-preview-sum">
            {result.problems.length ? (
              <span class="t-text-danger">{result.problems.join(" ")}</span>
            ) : (
              <>
                <strong>{result.rows.length}명</strong> 읽었어요
                {result.errorCount > 0 ? (
                  <span class="t-text-danger"> · 고칠 줄 {result.errorCount}개</span>
                ) : (
                  <span class="t-text-ok"> · 모두 넣을 수 있어요</span>
                )}
                <span class="hint">
                  {" "}
                  ({result.hasHeader ? "첫 줄을 제목으로 봤어요" : "열 순서"}: {result.columns.map((c) => FIELD_LABEL[c]).join(", ")})
                </span>
              </>
            )}
          </p>
          {result.rows.length > 0 && (
            <div class="t-table-wrap">
              <table class="t-table t-table-compact">
                <thead>
                  <tr>
                    <th scope="col">줄</th>
                    <th scope="col">학번</th>
                    <th scope="col">이름</th>
                    <th scope="col">PIN</th>
                    <th scope="col">모둠</th>
                    <th scope="col">확인</th>
                  </tr>
                </thead>
                <tbody>
                  {result.rows.map((r) => (
                    <tr key={r.line} class={r.errors.length ? "is-error" : ""}>
                      <td>{r.line}</td>
                      <td>{r.number || "—"}</td>
                      <td>{r.name || "—"}</td>
                      <td>{r.pin || <span class="hint">자동</span>}</td>
                      <td>{r.group || "—"}</td>
                      <td>
                        {r.errors.length ? (
                          <span class="t-text-danger">{r.errors.join(" ")}</span>
                        ) : r.notes.length ? (
                          <span class="t-text-warn">{r.notes.join(" ")}</span>
                        ) : (
                          <span class="t-text-ok">좋아요</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {result.errorCount > 0 && <p class="hint">빨간 줄을 위 칸에서 고치면 바로 다시 확인해요. 모든 줄이 맞아야 저장할 수 있어요.</p>}
        </div>
      )}
    </div>
  );
}
