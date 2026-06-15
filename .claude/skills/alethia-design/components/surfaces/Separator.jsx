import * as React from "react";

/** Hairline divider. `orientation="vertical"` for inline separators. */
export function Separator({ orientation = "horizontal", className = "", ...props }) {
  const cls = [
    "vx-sep",
    orientation === "vertical" ? "vx-sep--v" : "vx-sep--h",
    className,
  ]
    .filter(Boolean)
    .join(" ");
  return <div role="separator" aria-orientation={orientation} className={cls} {...props} />;
}
