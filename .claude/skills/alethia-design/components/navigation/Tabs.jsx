import * as React from "react";

/**
 * Tabs — controlled segmented navigation.
 * `variant="pill"` renders the inset pill group; default is the
 * underline rail. Pass `tabs` + `value` + `onValueChange`.
 */
export function Tabs({ tabs = [], value, onValueChange, variant = "underline", className = "", ...props }) {
  const cls = [
    "vx-tabs",
    variant === "pill" ? "vx-tabs--pill" : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <div className={cls} role="tablist" {...props}>
      {tabs.map((t) => {
        const tab = typeof t === "string" ? { id: t, label: t } : t;
        const active = tab.id === value;
        return (
          <button
            key={tab.id}
            role="tab"
            aria-selected={active}
            className={["vx-tab", active ? "vx-tab--active" : ""].filter(Boolean).join(" ")}
            onClick={() => onValueChange && onValueChange(tab.id)}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
