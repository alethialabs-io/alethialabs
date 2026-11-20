// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// What an environment's lifecycle status is CALLED on the Environments page: one function, read by
// the table's Status column and by the filter bar's Status facet, so a row and the option that
// selects it carry the same word.

import type { StatusTier } from "@repo/ui/status-badge";
import { IN_FLIGHT } from "@/lib/copy/vocabulary";

/**
 * The environment's lifecycle badge, from its OWN status (#6736). It used to read `deployPending` —
 * "the design moved ahead of what was deployed" — and call that "Deploying", so an environment with
 * an unsaved edit and no job at all read as deploying for as long as the edit stayed undeployed.
 * Undeployed changes are now their own chip; this says what the lifecycle says. The in-flight words
 * are the console's vocabulary (lib/copy/vocabulary.ts).
 */
export function envLifecycleBadge(status: string): { tier: StatusTier; label: string } {
	switch (status) {
		case "QUEUED":
			return { tier: "pending", label: IN_FLIGHT.queued };
		case "PROVISIONING":
			return { tier: "live", label: IN_FLIGHT.deploy };
		case "DESTROYING":
			return { tier: "live", label: IN_FLIGHT.destroy };
		case "FAILED":
			return { tier: "failed", label: "Failed" };
		case "DRAFT":
			return { tier: "idle", label: "Draft" };
		case "DESTROYED":
			return { tier: "disabled", label: "Destroyed" };
		default:
			return { tier: "active", label: "Live" };
	}
}

/** What each stage is called. */
export const STAGE_LABEL: Record<string, string> = {
	development: "Development",
	staging: "Staging",
	production: "Production",
};

/** A stage's label, or the stage itself when it is not one of the three. */
export function stageLabel(stage: string): string {
	return STAGE_LABEL[stage] ?? stage;
}

/**
 * Whether an environment's last run failed — the status after which cloud resources the run created
 * may still exist, with nothing in the console listing them.
 */
export function mayHoldResources(status: string): boolean {
	return status === "FAILED";
}

/**
 * The number of columns the Environments table has. Declared here, not with the columns, so the
 * route's skeleton can draw the same count without importing the columns' controls; the columns'
 * test holds the two to each other.
 */
export const ENVIRONMENT_COLUMN_COUNT = 4;
