/** 도는 동그라미. label 은 스크린리더용 (보이게 하려면 show) */
export function Spinner(props: { label?: string; show?: boolean; size?: number }) {
  const size = props.size ?? 20;
  return (
    <span class="ui-spinner-wrap" role="status">
      <span class="ui-spinner" style={{ width: size + "px", height: size + "px" }} aria-hidden="true" />
      <span class={props.show ? "" : "sr-only"}>{props.label ?? "불러오는 중"}</span>
    </span>
  );
}

/** 화면 가운데 큰 불러오기 */
export function PageSpinner(props: { label?: string }) {
  return (
    <div class="ui-page-center">
      <Spinner label={props.label ?? "불러오는 중이에요"} show size={32} />
    </div>
  );
}
