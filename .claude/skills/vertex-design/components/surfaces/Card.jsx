import * as React from "react";

/** Surface container. `interactive` adds hover affordance; `flat` drops the shadow. */
export function Card({ interactive = false, flat = false, className = "", children, ...props }) {
  const cls = [
    "vx-card",
    interactive ? "vx-card--interactive" : "",
    flat ? "vx-card--flat" : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <div className={cls} {...props}>
      {children}
    </div>
  );
}

export function CardHeader({ className = "", children, ...props }) {
  return <div className={["vx-card__header", className].filter(Boolean).join(" ")} {...props}>{children}</div>;
}
export function CardTitle({ className = "", children, ...props }) {
  return <div className={["vx-card__title", className].filter(Boolean).join(" ")} {...props}>{children}</div>;
}
export function CardDescription({ className = "", children, ...props }) {
  return <div className={["vx-card__desc", className].filter(Boolean).join(" ")} {...props}>{children}</div>;
}
export function CardBody({ className = "", children, ...props }) {
  return <div className={["vx-card__body", className].filter(Boolean).join(" ")} {...props}>{children}</div>;
}
export function CardFooter({ className = "", children, ...props }) {
  return <div className={["vx-card__footer", className].filter(Boolean).join(" ")} {...props}>{children}</div>;
}
