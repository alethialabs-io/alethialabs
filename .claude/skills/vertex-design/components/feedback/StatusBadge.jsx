import * as React from "react";

const LABELS = {
  active: "Active",
  online: "Online",
  success: "Success",
  pending: "Pending",
  processing: "Processing",
  queued: "Queued",
  idle: "Idle",
  failed: "Failed",
  destroyed: "Destroyed",
  disabled: "Disabled",
  live: "Live",
};
// Map many product statuses onto five grayscale visual tiers.
const TIER = {
  active: "active", online: "active", success: "active",
  pending: "pending", processing: "pending", queued: "pending",
  idle: "idle",
  failed: "failed", destroyed: "failed",
  disabled: "disabled",
  live: "live",
};

/**
 * StatusBadge — grayscale state indicator. State is read through dot
 * fill/shape + label, never color. Pass a known `status` or a custom label.
 */
export function StatusBadge({ status = "idle", children, showLabel = true, className = "", ...props }) {
  const tier = TIER[status] || "idle";
  const label = children != null ? children : LABELS[status] || status;
  return (
    <span className={["vx-status", `vx-status--${tier}`, className].filter(Boolean).join(" ")} {...props}>
      <span className="vx-status__dot" />
      {showLabel && <span>{label}</span>}
    </span>
  );
}
