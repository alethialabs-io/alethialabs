import * as React from "react";

/** Styled native select with a chevron affordance. */
export function Select({ options, className = "", children, ...props }) {
  return (
    <span className="vx-select-wrap">
      <select className={["vx-select", className].filter(Boolean).join(" ")} {...props}>
        {options
          ? options.map((o) => {
              const opt = typeof o === "string" ? { value: o, label: o } : o;
              return (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              );
            })
          : children}
      </select>
      <svg className="vx-select-wrap__chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
        <path d="m6 9 6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
}
