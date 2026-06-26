// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { cn } from "./utils";

/**
 * Grayscale status tiers. State is read through dot fill/shape + a mono
 * label — never hue. Five resting tiers plus `live` (blinking).
 */
export type StatusTier =
	| "active"
	| "pending"
	| "idle"
	| "failed"
	| "disabled"
	| "live";

/**
 * Maps product status strings (any casing) onto the five grayscale visual
 * tiers. Unknown statuses fall back to `idle`.
 */
const STATUS_TIER: Record<string, StatusTier> = {
	// active — running / healthy / done well
	active: "active",
	online: "active",
	success: "active",
	succeeded: "active",
	ready: "active",
	connected: "active",
	running: "active",
	// pending — in flight / waiting
	queued: "pending",
	pending: "pending",
	processing: "pending",
	claimed: "pending",
	provisioning: "pending",
	creating: "pending",
	updating: "pending",
	deploying: "pending",
	destroying: "pending",
	// idle — present but not doing anything
	idle: "idle",
	offline: "idle",
	draining: "idle",
	draft: "idle",
	cancelled: "idle",
	canceled: "idle",
	// failed — terminal error
	failed: "failed",
	error: "failed",
	errored: "failed",
	// disabled — gone / inert / skipped
	disabled: "disabled",
	destroyed: "disabled",
	skipped: "disabled",
};

/**
 * Resolves a product status string to its grayscale visual tier.
 */
export function statusTier(status: string): StatusTier {
	return STATUS_TIER[status.toLowerCase()] ?? "idle";
}

interface StatusBadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
	/** Product status (e.g. "ACTIVE", "PROCESSING", "FAILED"). */
	status: string;
	/** Override the auto-resolved tier when a status needs a specific look. */
	tier?: StatusTier;
	/** Custom label; defaults to the status string (rendered uppercase). */
	label?: React.ReactNode;
	/** Hide the text label and render only the dot. */
	showLabel?: boolean;
}

/**
 * StatusBadge — monochrome state indicator. Communicates status via dot
 * shape + luminance + a mono label, never color. Use this in place of any
 * colored status pill.
 */
export function StatusBadge({
	status,
	tier,
	label,
	showLabel = true,
	className,
	...props
}: StatusBadgeProps) {
	const resolved = tier ?? statusTier(status);
	return (
		<span
			className={cn("vx-status", `vx-status--${resolved}`, className)}
			{...props}
		>
			<span className="vx-status__dot" />
			{showLabel && <span>{label ?? status}</span>}
		</span>
	);
}
