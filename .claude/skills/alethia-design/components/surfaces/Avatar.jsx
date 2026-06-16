import * as React from "react";

const SIZES = { xs: 22, sm: 28, md: 36, lg: 44 };

/** Avatar — image with initials fallback. Square-ish radius or full circle. */
export function Avatar({ src, alt = "", initials, size = "md", square = false, className = "", style, ...props }) {
  const px = typeof size === "number" ? size : SIZES[size] || 36;
  return (
    <span
      className={["vx-avatar", className].filter(Boolean).join(" ")}
      style={{
        width: px,
        height: px,
        borderRadius: square ? "var(--radius-md)" : "var(--radius-full)",
        fontSize: px * 0.36,
        ...style,
      }}
      {...props}
    >
      {src ? <img src={src} alt={alt} /> : (initials || "").slice(0, 2).toUpperCase()}
    </span>
  );
}
