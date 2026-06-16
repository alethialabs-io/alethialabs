import * as React from "react";

/** Keyboard key cap — for shortcut hints (⌘K, ↑↓, q). */
export function Kbd({ className = "", children, ...props }) {
  return (
    <kbd className={["vx-kbd", className].filter(Boolean).join(" ")} {...props}>
      {children}
    </kbd>
  );
}
