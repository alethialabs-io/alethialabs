// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The shared grayscale vocabulary for a provisioning job — status → dot modifier, type → terse
// label, and the relative-time helper. Lives here (not beside one consumer) so the floating
// ActivityRail and the definition panel's Activity tab speak the same language.

import type { NodeStatusMeta } from "./node-status";

/** A job's status → the same grayscale vocabulary the cards use. Status never reads as hue. */
export const JOB_STATUS: Record<string, NodeStatusMeta["vx"]> = {
	QUEUED: "pending",
	CLAIMED: "pending",
	PROCESSING: "live",
	SUCCESS: "active",
	FAILED: "failed",
	CANCELLED: "disabled",
};

/** Job types, in the terse mono the board speaks. */
export const JOB_LABEL: Record<string, string> = {
	PLAN: "Plan",
	DEPLOY: "Deploy",
	DESTROY: "Destroy",
	AUDIT: "Audit",
	DETECT_DRIFT: "Drift",
	PROBE_CLUSTER: "Probe",
	CHART_SCAN: "Chart scan",
	IAC_SCAN: "IaC scan",
	ANALYZE_REPO: "Repo scan",
};

/** Terse relative time — "6 h" is what you actually want, not a full date. */
export function ago(iso: string): string {
	const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
	if (seconds < 60) return "now";
	const minutes = seconds / 60;
	if (minutes < 60) return `${Math.floor(minutes)} m`;
	const hours = minutes / 60;
	if (hours < 24) return `${Math.floor(hours)} h`;
	return `${Math.floor(hours / 24)} d`;
}
