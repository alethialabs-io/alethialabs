import * as React from "react";

/**
 * Vertex Button — the primary action primitive.
 * Monochrome by design: `primary` is solid ink, everything else
 * is border/fill/ghost. `destructive` stays grayscale (outline that
 * fills on hover) and relies on copy + an icon to signal danger.
 */
export function Button({
  variant = "primary",
  size = "md",
  icon = false,
  className = "",
  as,
  children,
  ...props
}) {
  const Comp = as || "button";
  const cls = [
    "vx-btn",
    `vx-btn--${variant}`,
    `vx-btn--${size}`,
    icon ? "vx-btn--icon" : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <Comp className={cls} {...props}>
      {children}
    </Comp>
  );
}
