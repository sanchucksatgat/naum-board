/** 켜기/끄기 단추 (role="switch"). 설명은 hint 로 */
export function Switch(props: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.checked}
      class={"ui-switch" + (props.checked ? " is-on" : "")}
      disabled={props.disabled}
      onClick={() => props.onChange(!props.checked)}
    >
      <span class="ui-switch-text">
        <span class="ui-switch-label">{props.label}</span>
        {props.hint ? <span class="hint">{props.hint}</span> : null}
      </span>
      <span class="ui-switch-track" aria-hidden="true">
        <span class="ui-switch-thumb" />
      </span>
    </button>
  );
}
