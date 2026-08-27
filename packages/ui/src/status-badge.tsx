// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
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
 *
 * The `idle` fallback is deliberate — a badge must render something rather than throw in a table
 * row — but it is also SILENT, and that silence has teeth. `STATUS_TIER` is keyed on the
 * infrastructure vocabulary (active/queued/failed/…); a domain with its own words gets `idle` for
 * every one of them and looks plausible while saying nothing. Support cases are the worked
 * example: not one of `open`, `pending_support`, `pending_customer`, `resolved`, `closed` is in
 * the map, so a naive migration renders an open urgent case and a closed one identically.
 *
 * So: `statusTier()` is for statuses in the map. Any other vocabulary must pass an explicit
 * `tier` to {@link StatusBadge}. In development an unrecognised status warns once, because the
 * failure mode is a badge that renders fine and means nothing — nobody files that as a bug.
 */
export function statusTier(status: string): StatusTier {
	const tier = STATUS_TIER[status.toLowerCase()];
	if (tier) return tier;
	if (process.env.NODE_ENV !== "production" && !warnedStatuses.has(status)) {
		warnedStatuses.add(status);
		console.warn(
			`[StatusBadge] "${status}" is not in STATUS_TIER, so it renders as "idle" — visually ` +
				`identical to every other unmapped status. Pass an explicit \`tier\` prop, or add it ` +
				`to STATUS_TIER if it belongs to the shared vocabulary.`,
		);
	}
	return "idle";
}

/** Warn once per distinct status, so a list of 200 rows does not produce 200 identical lines. */
const warnedStatuses = new Set<string>();

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
			/* A live subject is still under examination, so its clamp breathes
			   instead of settling. Every other tier reads from the dot alone. */
			className={cn(
				"vx-status",
				`vx-status--${resolved}`,
				resolved === "live" && "vx-clamp vx-clamp--tight vx-clamp--live",
				className,
			)}
			{...props}
		>
			<span className="vx-status__dot" />
			{showLabel && <span>{label ?? status}</span>}
		</span>
	);
}
