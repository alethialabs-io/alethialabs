// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The retention register: every promise this product makes about how long it keeps something,
// typed, and bound to the thing that actually enforces it (#2373).
//
// Before this, retention lived in two disconnected places. `docs/legal/GDPR_ACCOUNTABILITY.md`
// listed windows in prose, and `programmables.sql` had three `gc_*` functions with their own
// hard-coded defaults. Nothing tied them together, so the document could say 30 days while the code
// said 90 and both would look fine — and a promise nobody enforces is the one that ends up in a
// privacy policy.
//
// So each entry names its MECHANISM, and the mechanism is checkable:
//
//   `gc-function`  — a bounded-batch SQL function this repo ships and the reconcile loop calls. The
//                    window here IS the window passed to it (lib/reconcile/gc.ts reads both from the
//                    same constants), so the document, the code and the schedule cannot disagree.
//   `provider`     — held by a third party under their configuration. We do not enforce it and must
//                    not imply we do; the entry records what has to be verified with them.
//   `contractual`  — kept for as long as a legal obligation requires, and deliberately NOT deleted
//                    on request. Retention here is a duty, not a default.
//   `not-enforced` — a promise with nothing behind it yet. Allowed, because writing it down is how
//                    it stops being invisible — but it carries the evidence needed to close it, and
//                    `retention-registry.test.ts` refuses an entry that claims more.
//
// The point of the register is not to be long. It is that nothing may be retained by this product
// without appearing here, and `TestEveryGcFunctionIsRegistered` (in the sibling test) fails when a
// new `gc_*` lands in programmables.sql without an entry.

/** How a window is actually enforced — the difference between a promise and a control. */
export type RetentionMechanism =
	| "gc-function"
	| "provider"
	| "contractual"
	| "not-enforced";

export interface RetentionEntry {
	/** Stable id, used by the health report and by the tests. */
	readonly id: string;
	/** What is retained, in the words the privacy policy uses. */
	readonly subject: string;
	/** The Postgres table, when this product holds the data. Null when a provider does. */
	readonly table: string | null;
	/** The window in days. Null when there is no fixed window (contractual / provider-defined). */
	readonly windowDays: number | null;
	readonly mechanism: RetentionMechanism;
	/**
	 * The SQL function that enforces it. Required for `gc-function`, forbidden otherwise — an entry
	 * claiming enforcement it cannot name is the shape this register exists to prevent.
	 */
	readonly gcFunction: string | null;
	/**
	 * What makes the claim checkable, or what is missing. For `not-enforced` and `provider` this must
	 * name the evidence that would settle it, in the `NOT ESTABLISHED — requires …` form
	 * GDPR_ACCOUNTABILITY.md uses.
	 */
	readonly evidence: string;
}

/**
 * Retention windows in days, in ONE place.
 *
 * `lib/reconcile/gc.ts` imports these rather than re-declaring its own defaults, so the window this
 * register publishes is literally the window the GC runs with. That is the join the two halves were
 * missing; without it the register would be a third copy of the same numbers.
 *
 * Each is env-overridable at the GC, which is why the register also reports the EFFECTIVE window in
 * its health output — a deployment that overrides a window has changed a published promise, and the
 * operator should be able to see that.
 */
export const RETENTION_DEFAULT_DAYS = {
	jobLogs: 30,
	fleetActions: 90,
	authzActivity: 365,
} as const;

/**
 * Every retention promise, in the order a reader of the privacy policy meets them.
 *
 * ⚠️ Adding a `gc_*` function to programmables.sql without adding an entry here FAILS a test. That
 * is deliberate: a new automated deletion is a change to what the product promises, and it should
 * not be possible to ship one silently.
 */
export const RETENTION_REGISTRY: readonly RetentionEntry[] = [
	{
		id: "job-logs",
		subject: "Deploy and job logs, including anything a customer's own tooling printed",
		table: "job_logs",
		windowDays: RETENTION_DEFAULT_DAYS.jobLogs,
		mechanism: "gc-function",
		gcFunction: "gc_job_logs",
		evidence:
			"Enforced by public.gc_job_logs, called every 15 minutes by the reconcile loop " +
			"(lib/reconcile/loop.ts) in bounded batches. Window overridable by " +
			"ALETHIA_JOB_LOG_RETENTION_DAYS.",
	},
	{
		id: "fleet-actions",
		subject: "The fleet action ledger — what was provisioned, scaled or destroyed, and by whom",
		table: "fleet_actions",
		windowDays: RETENTION_DEFAULT_DAYS.fleetActions,
		mechanism: "gc-function",
		gcFunction: "gc_fleet_actions",
		evidence:
			"Enforced by public.gc_fleet_actions on the same reconcile schedule. Window overridable " +
			"by ALETHIA_FLEET_ACTION_RETENTION_DAYS.",
	},
	{
		id: "authz-activity",
		subject: "Authorization decisions — every allow and deny the policy engine made",
		table: "authz_activity_log",
		windowDays: RETENTION_DEFAULT_DAYS.authzActivity,
		mechanism: "gc-function",
		gcFunction: "gc_authz_activity_log",
		evidence:
			"Enforced by public.gc_authz_activity_log, which sets a transaction flag so the " +
			"append-only WORM trigger permits the pruning delete and nothing else can. A full year " +
			"of decisions is kept deliberately — it is the record that answers 'who could have seen " +
			"this?'. Window overridable by ALETHIA_AUTHZ_ACTIVITY_RETENTION_DAYS.",
	},
	{
		id: "pending-cloud-identities",
		subject: "Half-finished cloud connections that were never completed",
		table: "cloud_identities",
		windowDays: 1,
		mechanism: "gc-function",
		gcFunction: "gc_pending_identities",
		evidence:
			"Enforced by public.gc_pending_identities (24 hours). A connection abandoned mid-flow " +
			"holds an account identifier the customer never finished authorising, so it is removed " +
			"rather than kept as an orphan.",
	},
	{
		id: "legal-acceptance",
		subject: "Records of which Terms version an account accepted, and when",
		table: "legal_acceptance",
		windowDays: null,
		mechanism: "contractual",
		evidence:
			"Retained for as long as the contract it evidences can be disputed, and NOT deleted on " +
			"request: it is processed on a legal-obligation basis, and erasing it would destroy the " +
			"only proof of what the account agreed to — including proof that favours the account. " +
			"Erasure records the retention rather than performing it (#2373's deletion path).",
		gcFunction: null,
	},
	{
		id: "commerce-order",
		subject: "Orders, what was charged, and consumer withdrawal outcomes",
		table: "commerce_order",
		windowDays: null,
		mechanism: "contractual",
		evidence:
			"NOT ESTABLISHED — requires the statutory accounting retention period under Bulgarian " +
			"law to be confirmed and recorded here. The same gap GDPR_ACCOUNTABILITY.md already " +
			"records for billing records; it is not closed by this issue, and stating a number we " +
			"have not confirmed would be worse than stating none.",
		gcFunction: null,
	},
	{
		id: "product-analytics",
		subject: "Product analytics and client diagnostics, for accounts that consented",
		table: null,
		windowDays: null,
		mechanism: "provider",
		evidence:
			"NOT ESTABLISHED — requires the configured PostHog EU Cloud retention to be read from " +
			"the project settings and recorded here. Held by the provider under their configuration; " +
			"this product deletes nothing there, and must not publish a maximum it does not control.",
		gcFunction: null,
	},
	{
		id: "backups",
		subject: "Database backups",
		table: null,
		windowDays: null,
		mechanism: "not-enforced",
		evidence:
			"NOT ESTABLISHED — requires the backup rotation to be evidenced, and requires the " +
			"deletion queue to be replayed after any restore before normal operation resumes. A " +
			"backup that outlives a deletion silently reinstates it, which is why the tombstone in " +
			"the deletion path is restore-resistant and this entry stays open until the rotation is " +
			"documented.",
		gcFunction: null,
	},
];

/** One entry by id, or null. */
export function retentionEntry(id: string): RetentionEntry | null {
	return RETENTION_REGISTRY.find((e) => e.id === id) ?? null;
}

/** The entries this product actually enforces itself. */
export function enforcedRetention(): RetentionEntry[] {
	return RETENTION_REGISTRY.filter((e) => e.mechanism === "gc-function");
}

/**
 * The entries with an open gap — rendered in the health report and in the accountability record.
 *
 * Deliberately includes `provider`: not controlling a retention is not the same as having no duty
 * about it, and the register should read as honestly to us as it does to a regulator.
 */
export function unenforcedRetention(): RetentionEntry[] {
	return RETENTION_REGISTRY.filter(
		(e) => e.mechanism === "not-enforced" || e.mechanism === "provider",
	);
}
