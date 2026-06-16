import * as React from "react";

/** Single-line text input. Add `mono` for code / token / ID entry. */
export function Input({ mono = false, className = "", ...props }) {
  const cls = ["vx-input", mono ? "vx-input--mono" : "", className].filter(Boolean).join(" ");
  return <input className={cls} {...props} />;
}

/** Multi-line text input. */
export function Textarea({ className = "", ...props }) {
  return <textarea className={["vx-textarea", className].filter(Boolean).join(" ")} {...props} />;
}
