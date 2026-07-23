// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The TS mirror of the compat Report contract (packages/core/compat). It matches
// the Go shapes verbatim so a report crosses the Go↔TS boundary unchanged
// (snake_case JSON keys: `catalog_version`, `not_evaluable`). Kept in this
// dedicated file — NOT the shared `jsonb.types.ts` — so the `wave:compat` scope
// stays disjoint from other active waves. See `packages/core/verify` for the
// engine this mirrors.

/** The outcome of a single control (or the overall verdict). */
export type CompatStatus = "pass" | "fail" | "warn" | "not_evaluable";

/** The risk weight of a control. */
export type CompatSeverity = "high" | "medium" | "low";

/**
 * The reserved control ID under which a blocking compat report surfaces at the
 * fail-closed apply gate (#1215). The engine emits granular controls; the apply
 * unit maps a blocking report to this ID.
 */
export const COMPAT_CONTROL_GATE_ID = "COMPAT-001";

/** A single offending (or noteworthy) subject within a control. */
export interface CompatFinding {
	address: string;
	message: string;
}

/** The outcome of one compatibility control over the config. */
export interface CompatControlResult {
	id: string;
	title: string;
	severity: CompatSeverity;
	status: CompatStatus;
	findings?: CompatFinding[];
	/** Plain-language note of what the control could NOT judge (the honesty surface). */
	coverage?: string;
}

/** A quick tally of control statuses. */
export interface CompatSummary {
	pass: number;
	fail: number;
	warn: number;
	not_evaluable: number;
}

/** The full compatibility result for one proposed config. */
export interface CompatReport {
	verdict: CompatStatus;
	catalog_version: string;
	controls: CompatControlResult[];
	summary: CompatSummary;
}

/** An enabled platform component and its pinned version. */
export interface CompatComponentRef {
	id: string;
	version: string;
}

/** An enabled add-on chart and its pinned version. */
export interface CompatAddOnRef {
	id: string;
	version?: string;
}

/**
 * The proposed config the engine evaluates: the target cloud(s), the cluster
 * Kubernetes version, and the enabled components + add-ons. The input contract
 * downstream units populate (buildConfigSnapshot at config time; the apply gate).
 */
export interface CompatSubject {
	providers?: string[];
	/** A bare minor ("1.35") or a concrete patch ("1.35.6"); only major.minor is compared. */
	k8sVersion?: string;
	components?: CompatComponentRef[];
	addons?: CompatAddOnRef[];
}

/** An authorized, time-boxed waiver of one or more failing controls. */
export interface CompatOverride {
	controls: string[];
	reason?: string;
	by?: string;
	/** ISO-8601 timestamp; omitted/empty means no expiry. */
	expiry?: string;
}
