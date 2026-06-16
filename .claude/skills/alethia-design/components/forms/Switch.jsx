import * as React from "react";

/** On/off toggle. Controlled via `checked` + `onChange`, like an input. */
export function Switch({ className = "", ...props }) {
  return (
    <label className={["vx-switch", className].filter(Boolean).join(" ")}>
      <input type="checkbox" role="switch" {...props} />
      <span className="vx-switch__track" />
      <span className="vx-switch__thumb" />
    </label>
  );
}
