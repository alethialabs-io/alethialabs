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
//   `reconcile-task` — a bounded, paged TypeScript sweep on the reconcile loop (lib/reconcile/loop.ts)
//                    rather than a SQL function, because deciding what to do with a row needs app
//                    code (the Elench drafts sweep settles a silent claim before it deletes). The
//                    window here IS the sweep's window: the sweep imports it from this file, or —
//                    for a sweep that predates the register and lives outside this module (the
//                    removed-inventory purge in lib/cloud-providers/sweep.ts) — the register test
//                    pins the sweep's own default to it, so the two cannot drift apart.
//   `provider`     — held by a third party under their configuration. We do not enforce it and must
//                    not imply we do; the entry records what has to be verified with them.
//   `contractual`  — kept for as long as a legal obligation requires, and deliberately NOT deleted
//                    on request. Retention here is a duty, not a default.
//   `not-enforced` — a promise with nothing behind it yet. Allowed, because writing it down is how
//                    it stops being invisible — but it carries the evidence needed to close it, and
//                    `retention-registry.test.ts` refuses an entry that claims more.
//
// The point of the register is not to be long. It is that nothing may be retained by this product
// without appearing here, and the "registers every gc_* function the database defines" case in
// apps/console/tests/privacy/retention-registry.test.ts fails when a new `gc_*` lands in
// programmables.sql without an entry.

/** How a window is actually enforced — the difference between a promise and a control. */
export type RetentionMechanism =
	| "gc-function"
	| "reconcile-task"
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
	// ADR 0001 §9 / Q2: an Elench draft nobody writes, and a discarded one (its 24 h Undo window).
	elenchDrafts: 30,
	elenchDraftsDiscarded: 1,
	// The Privacy Policy: "Support and contractual correspondence: up to 3 years after the matter
	// closes". 3 × 365 — never more than three calendar years, whatever the leap days.
	supportCases: 3 * 365,
	// The Privacy Policy: "Removed cloud inventory and capability observations: 7 days by default".
	// Enforced by lib/cloud-providers/sweep.ts with its own default; the register test pins the two.
	removedInventory: 7,
} as const;

/**
 * The off-box backup rotation, as `deploy/prod/backup/backup.sh` and `infra/backup-account/` set it.
 * Not a retention this product's code enforces — the backup job and the bucket's lifecycle rules do —
 * so these are the numbers the `backups` entry states, and the register test pins each one to the
 * file that sets it.
 */
export const BACKUP_ROTATION = {
	/** `BACKUP_KEEP_DAILY`'s default in backup.sh: daily copies kept in script mode. */
	keepDaily: 14,
	/** `BACKUP_KEEP_WEEKLY`'s default in backup.sh: weekly copies kept in script mode. */
	keepWeekly: 8,
	/** Production (bucket mode): a weekly copy's current version expires after this many days. */
	bucketWeeklyDays: 60,
	/** Production (bucket mode): an expired version is removed this many days after it stops being current. */
	bucketNoncurrentDays: 16,
} as const;

/**
 * The longest any backup copy survives in production: a weekly copy's 60 days current plus 16 days
 * noncurrent. A deletion is therefore gone from every backup at most this long after it happened —
 * provided a restore replays the erasure tombstones (the open half of the `backups` entry).
 */
export const BACKUP_MAX_DAYS = BACKUP_ROTATION.bucketWeeklyDays + BACKUP_ROTATION.bucketNoncurrentDays;

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
		id: "elench-drafts",
		subject: "Unsent Elench chat messages (drafts), which may hold pasted secrets",
		table: "elench_drafts",
		windowDays: RETENTION_DEFAULT_DAYS.elenchDrafts,
		mechanism: "reconcile-task",
		gcFunction: null,
		evidence:
			"Enforced by the elench-drafts-sweep task (lib/elench/drafts-sweep.ts), run daily by the " +
			"reconcile loop: a draft not written for 30 days is deleted, whether or not its user is " +
			"still a member of the org. A draft being sent under a live claim is never deleted. " +
			"Erased on account deletion in every org (lib/privacy/erasure-plan.ts).",
	},
	{
		id: "elench-drafts-discarded",
		subject: "Discarded Elench drafts, kept only for the Undo window",
		table: "elench_drafts",
		windowDays: RETENTION_DEFAULT_DAYS.elenchDraftsDiscarded,
		mechanism: "reconcile-task",
		gcFunction: null,
		evidence:
			"Enforced by the same elench-drafts-sweep task: a discarded draft is deleted 24 hours " +
			"after it was discarded. The task runs daily, so a discarded draft can stay up to about " +
			"two days.",
	},
	{
		id: "support-cases",
		subject:
			"Support and contractual correspondence — support cases, their messages, read markers and attachments",
		table: "support_cases",
		windowDays: RETENTION_DEFAULT_DAYS.supportCases,
		mechanism: "reconcile-task",
		gcFunction: null,
		evidence:
			"Enforced by the gc-support-cases task (gcSupportCases in lib/reconcile/gc.ts), run hourly " +
			"by the reconcile loop in bounded pages: a case that is resolved or closed, and has been for " +
			"3 years, is deleted. The matter closes at its latest resolved_at (resolved) or closed_at " +
			"(closed), or its last message if that is later; a reopened case is not deleted, and its " +
			"clock restarts when it settles again. Its messages, read markers and attachment rows go " +
			"with it (ON DELETE CASCADE), its attachment files are deleted from storage first — a case " +
			"whose file cannot be deleted is kept and retried, so no file outlives its record — and its " +
			"classification assignments are removed in the same transaction.",
	},
	{
		id: "removed-cloud-inventory",
		subject:
			"Removed cloud inventory and capability observations — resources deleted in a connected cloud",
		table: null,
		windowDays: RETENTION_DEFAULT_DAYS.removedInventory,
		mechanism: "reconcile-task",
		gcFunction: null,
		evidence:
			"Enforced by the connection sweeper (runConnectionSweep in lib/cloud-providers/sweep.ts, " +
			"every minute on every app instance): rows soft-removed (removed_at) more than 7 days ago " +
			"are deleted from every cloud inventory table and from the launchable-service and quota " +
			"capability tables (gcRemovedInventory, gcRemovedServiceCapabilities, " +
			"gcRemovedQuotaCapabilities). The window is the sweep's own default, overridable by " +
			"ALETHIA_INVENTORY_RETENTION_DAYS; the register test pins that default to this entry.",
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
		subject: "Database and storage backups, encrypted and kept off the production box",
		table: null,
		windowDays: BACKUP_MAX_DAYS,
		mechanism: "not-enforced",
		evidence:
			"The rotation is established, outside this product's code. deploy/prod/backup/backup.sh " +
			"takes a nightly copy and keeps 14 dailies and 8 weeklies by default (BACKUP_KEEP_DAILY, " +
			"BACKUP_KEEP_WEEKLY); in production (BACKUP_RETENTION=bucket) the bucket's lifecycle " +
			"rules expire them instead (infra/backup-account/main.tf: dailies 15 days, weeklies 60, " +
			"then 16 days noncurrent), so no copy outlives 76 days. The erasure tombstones are " +
			"exported off-box hourly, so a restore of an older copy CAN replay the erasures made " +
			"after it. NOT ESTABLISHED — requires the restore procedure to replay those tombstones " +
			"before normal operation resumes: nothing in this repository does it yet, and a backup " +
			"that outlives a deletion silently reinstates it when restored.",
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
