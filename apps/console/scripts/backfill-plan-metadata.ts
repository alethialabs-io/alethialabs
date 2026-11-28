// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Backfill: bring stored plan metadata to the current shape (#7949).
//
// #7800 changed what a runner records for a PLAN job in `jobs.execution_metadata.plan_result`: each
// resource change keeps its identity, its actions, `change.after` without any value the
// `after_sensitive` / `after_unknown` masks mark, and the `after_unknown` mask; a plan with no
// `resource_changes` records only `{ format_version }`. Rows written before that release carry the
// fuller, earlier shape, in two places:
//
//   1. PLAN jobs: `execution_metadata.plan_result`;
//   2. AUDIT jobs with `config_snapshot->>'audit_kind' = 'plan'`: `config_snapshot.audit_input`, a JSON
//      string copied from a plan (app/server/actions/canvas-jobs.ts copies `plan_result`;
//      app/server/actions/audit.ts takes a pasted `tofu show -json`).
//
// The reduction below is a port of apps/runner/internal/agent/plan_metadata.go (applyPlanChanges,
// noChangePlanResult) and of the PLAN metadata block in runner.go that chooses between them. The
// two are held together by one fixture, apps/runner/internal/agent/testdata/plan-metadata/cases.json,
// which the Go test runs through the runner's plan path and tests/scripts/backfill-plan-metadata.test.ts
// runs through `reducePlanResult`. Change one side and that fixture says so.
//
// Usage (the database URL comes from ALETHIA_DATABASE_URL):
//   pnpm -C apps/console run db:backfill-plan-metadata              # dry run: counts only
//   pnpm -C apps/console run db:backfill-plan-metadata --apply      # rewrite, batch by batch
//   PLAN_METADATA_BATCH=200 …                                      # batch size (default 500)
//
// It prints COUNTS ONLY — never a stored value, never a row id.
//
// SAFE TO RE-RUN: a row is rewritten only when its reduced value differs from the stored one, and the
// write is a compare-and-set on the exact text that was read, so a second run changes 0 rows and a
// row changed in between is counted as `raced` and left for the next run. Each batch is one
// transaction.
//
// AN AUDIT ROW IS SIGNED. `config_snapshot_sig` is an HMAC of the snapshot that the claim route
// re-verifies (lib/runners/snapshot-sig.ts), so an audit row is rewritten only when it can be
// re-signed: it is no longer claimable (SUCCESS, FAILED or CANCELLED), and either it carries no
// signature or ALETHIA_SNAPSHOT_HMAC_KEY is set and verifies the signature it has. Anything else is
// counted and left as it is.
//
// A NUMBER IS NEVER ROUNDED. A stored value is read as text and parsed with the source of every
// number in view; a row holding a number that a JavaScript double would not carry exactly (more than
// 15 significant digits, or out of range) is counted as `unreadable` and left as it is, rather than
// written back altered.

import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { canonicalJson, signSnapshot, verifySnapshot } from "@/lib/runners/snapshot-sig";

// ── The reduction: a port of apps/runner/internal/agent/plan_metadata.go ────────────────────────

/** A JSON object, as JSON.parse produces it. */
type JsonObject = { [key: string]: unknown };

/** True for a JSON object (not an array, not null). */
function isObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The fields of a resource change that say which resource it is (planChangeIdentityKeys). */
const PLAN_CHANGE_IDENTITY_KEYS = [
	"address",
	"module_address",
	"mode",
	"type",
	"name",
	"index",
	"provider_name",
] as const;

/** Copies a resource change's identity fields into a new list of entries (planChangeIdentity). */
function planChangeIdentity(rc: JsonObject): Array<[string, unknown]> {
	const kept: Array<[string, unknown]> = [];
	for (const k of PLAN_CHANGE_IDENTITY_KEYS) {
		if (Object.hasOwn(rc, k)) kept.push([k, rc[k]]);
	}
	return kept;
}

/** A resource change's actions, only its string entries, or an empty list (planChangeActions). */
function planChangeActions(rc: JsonObject): string[] {
	const change = rc.change;
	if (!isObject(change) || !Array.isArray(change.actions)) return [];
	return change.actions.filter((a): a is string => typeof a === "string");
}

/** True when a mask marks the whole value (marksAll). */
function marksAll(mask: unknown): boolean {
	return mask === true;
}

/** True when a mask marks nothing: absent, null or false (isEmptyMask). */
function isEmptyMask(mask: unknown): boolean {
	return mask === undefined || mask === null || mask === false;
}

/** The part of an object mask that covers member k, or undefined (memberMask). */
function memberMask(mask: unknown, k: string): unknown {
	return isObject(mask) && Object.hasOwn(mask, k) ? mask[k] : undefined;
}

/** The part of an array mask that covers element i, or undefined (elementMask). */
function elementMask(mask: unknown, i: number): unknown {
	return Array.isArray(mask) && i < mask.length ? mask[i] : undefined;
}

/** A value with nothing kept: the Go `(nil, false)`. */
const DROPPED = { keep: false } as const;

/** The outcome of reducing one planned value: dropped, or kept with what remains of it. */
type Planned = typeof DROPPED | { keep: true; value: unknown };

/**
 * `v` without any part the sensitive or unknown mask marks (plannedValue). A mask whose shape does
 * not fit the value drops the value; a dropped array element becomes null so positions hold.
 */
function plannedValue(v: unknown, sensitive: unknown, unknown: unknown): Planned {
	if (marksAll(sensitive) || marksAll(unknown)) return DROPPED;
	if (isObject(v)) {
		if (!(isEmptyMask(sensitive) || isObject(sensitive))) return DROPPED;
		if (!(isEmptyMask(unknown) || isObject(unknown))) return DROPPED;
		const out: Array<[string, unknown]> = [];
		for (const [k, member] of Object.entries(v)) {
			const kept = plannedValue(member, memberMask(sensitive, k), memberMask(unknown, k));
			if (kept.keep) out.push([k, kept.value]);
		}
		return { keep: true, value: Object.fromEntries(out) };
	}
	if (Array.isArray(v)) {
		if (!(isEmptyMask(sensitive) || Array.isArray(sensitive))) return DROPPED;
		if (!(isEmptyMask(unknown) || Array.isArray(unknown))) return DROPPED;
		return {
			keep: true,
			value: v.map((member, i) => {
				const kept = plannedValue(member, elementMask(sensitive, i), elementMask(unknown, i));
				return kept.keep ? kept.value : null;
			}),
		};
	}
	if (!isEmptyMask(sensitive) || !isEmptyMask(unknown)) return DROPPED;
	return { keep: true, value: v };
}

/** A copy of a mask keeping only its shape and booleans, or DROPPED when it is none (boolMask). */
function boolMask(mask: unknown): Planned {
	if (typeof mask === "boolean") return { keep: true, value: mask };
	if (isObject(mask)) {
		const out: Array<[string, unknown]> = [];
		for (const [k, v] of Object.entries(mask)) {
			const kept = boolMask(v);
			if (kept.keep) out.push([k, kept.value]);
		}
		return { keep: true, value: Object.fromEntries(out) };
	}
	if (Array.isArray(mask)) {
		return {
			keep: true,
			value: mask.map((v) => {
				const kept = boolMask(v);
				return kept.keep ? kept.value : null;
			}),
		};
	}
	return DROPPED;
}

/**
 * An apply plan's resource_changes reduced to identity, actions, planned values minus every
 * sensitive or unknown one, and the unknown mask (applyPlanChanges).
 */
export function applyPlanChanges(raw: unknown): JsonObject[] {
	if (!Array.isArray(raw)) return [];
	const out: JsonObject[] = [];
	for (const el of raw) {
		if (!isObject(el)) continue;
		const change: Array<[string, unknown]> = [["actions", planChangeActions(el)]];
		const c = el.change;
		if (isObject(c)) {
			const after = c.after;
			if (isObject(after)) {
				const kept = plannedValue(after, c.after_sensitive, c.after_unknown);
				if (kept.keep) change.push(["after", kept.value]);
			}
			const mask = boolMask(c.after_unknown);
			if (mask.keep) change.push(["after_unknown", mask.value]);
		}
		out.push(Object.fromEntries([...planChangeIdentity(el), ["change", Object.fromEntries(change)]]));
	}
	return out;
}

/** What a plan with no resource_changes key records: its format_version alone (noChangePlanResult). */
function noChangePlanResult(plan: JsonObject): JsonObject {
	return typeof plan.format_version === "string" ? { format_version: plan.format_version } : {};
}

/**
 * The plan_result the current runner records for a plan document (or for an earlier runner's
 * plan_result, which is the plan's resource_changes or the whole document): the PLAN metadata block
 * of apps/runner/internal/agent/runner.go.
 */
export function reducePlanResult(plan: JsonObject): JsonObject {
	return Object.hasOwn(plan, "resource_changes")
		? { resource_changes: applyPlanChanges(plan.resource_changes) }
		: noChangePlanResult(plan);
}

/**
 * The reduced form of an audit's plan input, or null when the input is not a plan this backfill
 * recognises — an object with `resource_changes` or a string `format_version`. An audit input is
 * customer text, so anything else is left exactly as it is.
 */
export function reduceAuditPlan(plan: JsonObject): JsonObject | null {
	if (!Object.hasOwn(plan, "resource_changes") && typeof plan.format_version !== "string") return null;
	return reducePlanResult(plan);
}

// ── Exact parsing ────────────────────────────────────────────────────────────────────────────────

/** What a JSON.parse reviver is handed as its third argument (Node 22+). */
interface ReviverContext {
	source?: string;
}

/** True when a JSON number literal round-trips exactly through a JavaScript double. */
export function numberIsExact(source: string, value: number): boolean {
	if (!Number.isFinite(value)) return false;
	const mantissa = source.replace(/^-/, "").split(/[eE]/)[0] ?? "";
	const digits = mantissa.replace(".", "").replace(/^0+/, "").replace(/0+$/, "");
	if (digits.length > 15) return false;
	// A non-zero literal that underflowed to zero did not survive.
	return !(value === 0 && digits.length > 0);
}

/**
 * Parses JSON text and reports whether every number in it survived exactly. Fails closed: a runtime
 * that does not hand the reviver each number's source makes every number count as inexact.
 */
export function parseExact(text: string): { ok: true; value: unknown } | { ok: false } {
	let exact = true;
	let value: unknown;
	try {
		value = JSON.parse(text, (_key: string, v: unknown, context?: ReviverContext) => {
			if (typeof v === "number" && !(context?.source !== undefined && numberIsExact(context.source, v))) {
				exact = false;
			}
			return v;
		});
	} catch {
		return { ok: false };
	}
	return exact ? { ok: true, value } : { ok: false };
}

/** True when two JSON values are the same value, whatever their key order. */
function sameJson(a: unknown, b: unknown): boolean {
	return canonicalJson(a) === canonicalJson(b);
}

// ── Row decisions ────────────────────────────────────────────────────────────────────────────────

/** What the backfill decided for one row. `change` carries the text to write. */
export type RowPlan =
	| { kind: "change"; text: string }
	| { kind: "unchanged" }
	| { kind: "unreadable" }
	| { kind: "pending" }
	| { kind: "unsignable" };

/** The decision for one PLAN row, given its `execution_metadata->'plan_result'` as text. */
export function planRowPlan(storedText: string): RowPlan {
	const parsed = parseExact(storedText);
	if (!parsed.ok || !isObject(parsed.value)) return { kind: "unreadable" };
	const next = reducePlanResult(parsed.value);
	if (sameJson(parsed.value, next)) return { kind: "unchanged" };
	return { kind: "change", text: JSON.stringify(next) };
}

/** The job statuses after which a job is never claimed again. */
const SETTLED_STATUSES = new Set(["SUCCESS", "FAILED", "CANCELLED"]);

/** One AUDIT row as the backfill reads it. */
export interface AuditRow {
	status: string;
	/** `config_snapshot` as text. */
	config_snapshot: string;
	config_snapshot_sig: string | null;
}

/** The decision for one AUDIT row; a `change` carries the new snapshot text and its signature. */
export type AuditRowPlan = Exclude<RowPlan, { kind: "change" }> | { kind: "change"; text: string; sig: string | null };

/**
 * The decision for one AUDIT row of kind `plan`. `keyConfigured` says whether
 * ALETHIA_SNAPSHOT_HMAC_KEY is set, without which a signed row cannot be re-signed.
 */
export function auditRowPlan(row: AuditRow, keyConfigured: boolean): AuditRowPlan {
	const snapshot = parseExact(row.config_snapshot);
	if (!snapshot.ok || !isObject(snapshot.value)) return { kind: "unreadable" };
	const input = snapshot.value.audit_input;
	if (typeof input !== "string") return { kind: "unreadable" };
	const plan = parseExact(input);
	if (!plan.ok || !isObject(plan.value)) return { kind: "unreadable" };
	const next = reduceAuditPlan(plan.value);
	if (next === null) return { kind: "unreadable" };
	if (sameJson(plan.value, next)) return { kind: "unchanged" };
	if (!SETTLED_STATUSES.has(row.status)) return { kind: "pending" };
	if (row.config_snapshot_sig !== null && (!keyConfigured || !verifySnapshot(snapshot.value, row.config_snapshot_sig))) {
		return { kind: "unsignable" };
	}
	const nextSnapshot = { ...snapshot.value, audit_input: JSON.stringify(next) };
	return {
		kind: "change",
		text: JSON.stringify(nextSnapshot),
		sig: row.config_snapshot_sig === null ? null : signSnapshot(nextSnapshot),
	};
}

// ── The pass ─────────────────────────────────────────────────────────────────────────────────────

/** Tally of one pass over one kind of row. */
export interface BackfillCounts {
	/** Rows the selection matched. */
	matched: number;
	/** Rows rewritten (on a dry run: rows that would be rewritten). */
	changed: number;
	/** Rows already in the current shape. */
	unchanged: number;
	/** Rows whose value is not one this backfill reads (left as they are). */
	unreadable: number;
	/** AUDIT rows still claimable (left for a later run). */
	pending: number;
	/** AUDIT rows whose signature cannot be renewed (left as they are). */
	unsignable: number;
	/** Rows that changed between the read and the write (left for the next run). */
	raced: number;
}

/** A zeroed tally. */
function zeroCounts(): BackfillCounts {
	return { matched: 0, changed: 0, unchanged: 0, unreadable: 0, pending: 0, unsignable: 0, raced: 0 };
}

/** One PLAN row read for the backfill. */
export interface PlanRow {
	id: string;
	plan_result: string;
}

/** One AUDIT row read for the backfill. */
export interface AuditDbRow extends AuditRow {
	id: string;
}

/** The database operations the pass needs, inside one batch's transaction. */
export interface BackfillTx {
	/** PLAN rows holding a plan_result, ids after `cursor`, in id order. */
	selectPlanRows(cursor: string, limit: number): Promise<PlanRow[]>;
	/** Writes `text` as the row's plan_result if it still holds `expected`; true when it did. */
	updatePlanResult(id: string, expected: string, text: string): Promise<boolean>;
	/** AUDIT rows of kind `plan`, ids after `cursor`, in id order. */
	selectAuditRows(cursor: string, limit: number): Promise<AuditDbRow[]>;
	/** Writes the snapshot and signature if the row still holds what was read; true when it did. */
	updateAuditSnapshot(row: AuditDbRow, text: string, sig: string | null): Promise<boolean>;
}

/** A database handle that runs one batch at a time in a transaction. */
export interface BackfillDb {
	transaction<T>(fn: (tx: BackfillTx) => Promise<T>): Promise<T>;
}

/** How a pass runs. */
export interface BackfillOptions {
	apply: boolean;
	batch: number;
	keyConfigured: boolean;
}

const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

/** Counts one non-change decision. */
function countSkip(counts: BackfillCounts, kind: Exclude<RowPlan["kind"], "change">): void {
	counts[kind]++;
}

/** Walks every PLAN row with a plan_result, keyset-paged by id, one transaction per batch. */
export async function backfillPlanRows(db: BackfillDb, opts: BackfillOptions): Promise<BackfillCounts> {
	const counts = zeroCounts();
	let cursor = ZERO_UUID;
	for (;;) {
		const size = await db.transaction(async (tx) => {
			const rows = await tx.selectPlanRows(cursor, opts.batch);
			for (const row of rows) {
				cursor = row.id;
				counts.matched++;
				const plan = planRowPlan(row.plan_result);
				if (plan.kind !== "change") {
					countSkip(counts, plan.kind);
				} else if (!opts.apply || (await tx.updatePlanResult(row.id, row.plan_result, plan.text))) {
					counts.changed++;
				} else {
					counts.raced++;
				}
			}
			return rows.length;
		});
		if (size < opts.batch) break;
	}
	return counts;
}

/** Walks every AUDIT row of kind `plan`, keyset-paged by id, one transaction per batch. */
export async function backfillAuditRows(db: BackfillDb, opts: BackfillOptions): Promise<BackfillCounts> {
	const counts = zeroCounts();
	let cursor = ZERO_UUID;
	for (;;) {
		const size = await db.transaction(async (tx) => {
			const rows = await tx.selectAuditRows(cursor, opts.batch);
			for (const row of rows) {
				cursor = row.id;
				counts.matched++;
				const plan = auditRowPlan(row, opts.keyConfigured);
				if (plan.kind !== "change") {
					countSkip(counts, plan.kind);
				} else if (!opts.apply || (await tx.updateAuditSnapshot(row, plan.text, plan.sig))) {
					counts.changed++;
				} else {
					counts.raced++;
				}
			}
			return rows.length;
		});
		if (size < opts.batch) break;
	}
	return counts;
}

/** Minimal typed handle for the postgres-js client. */
type Sql = ReturnType<typeof postgres>;

/** The pass's operations over a postgres-js transaction. */
function postgresTx(sql: postgres.ISql): BackfillTx {
	return {
		selectPlanRows: (cursor, limit) => sql<PlanRow[]>`
			select id, (execution_metadata->'plan_result')::text as plan_result from jobs
			 where job_type = 'PLAN' and id > ${cursor}
			   and execution_metadata->'plan_result' is not null
			 order by id limit ${limit}`,
		updatePlanResult: async (id, expected, text) => {
			const written = await sql`
				update jobs set execution_metadata = jsonb_set(execution_metadata, '{plan_result}', ${text}::jsonb)
				 where id = ${id} and (execution_metadata->'plan_result')::text = ${expected}`;
			return written.count === 1;
		},
		selectAuditRows: (cursor, limit) => sql<AuditDbRow[]>`
			select id, status::text as status, config_snapshot::text as config_snapshot, config_snapshot_sig from jobs
			 where job_type = 'AUDIT' and id > ${cursor}
			   and config_snapshot->>'audit_kind' = 'plan'
			 order by id limit ${limit}`,
		updateAuditSnapshot: async (row, text, sig) => {
			const written = await sql`
				update jobs set config_snapshot = ${text}::jsonb, config_snapshot_sig = ${sig}
				 where id = ${row.id}
				   and config_snapshot::text = ${row.config_snapshot}
				   and config_snapshot_sig is not distinct from ${row.config_snapshot_sig}
				   and status in ('SUCCESS', 'FAILED', 'CANCELLED')`;
			return written.count === 1;
		},
	};
}

/** A BackfillDb over a postgres-js client: each batch in `sql.begin`, or with no transaction on a dry run. */
function postgresDb(sql: Sql, apply: boolean): BackfillDb {
	return {
		transaction: async (fn) => {
			if (!apply) return fn(postgresTx(sql));
			let out: Awaited<ReturnType<typeof fn>> | undefined;
			await sql.begin(async (tx) => {
				out = await fn(postgresTx(tx));
			});
			if (out === undefined) throw new Error("a batch transaction returned nothing");
			return out;
		},
	};
}

/** One tally as a single line of counts. */
export function formatCounts(label: string, c: BackfillCounts, apply: boolean): string {
	const verb = apply ? "changed" : "would change";
	return (
		`  ${label}: matched ${c.matched}, ${verb} ${c.changed}, unchanged ${c.unchanged}, ` +
		`unreadable ${c.unreadable}, pending ${c.pending}, unsignable ${c.unsignable}, raced ${c.raced}`
	);
}

/** Reads the command line: `--apply` rewrites, anything else is a dry run. Unknown flags refuse. */
export function parseArgs(argv: string[]): { apply: boolean } | { error: string } {
	let apply = false;
	for (const arg of argv) {
		if (arg === "--apply") apply = true;
		else if (arg === "--dry-run" || arg === "--") continue;
		else return { error: `unknown argument ${JSON.stringify(arg)} (expected --dry-run or --apply)` };
	}
	return { apply };
}

/** Runs both passes against ALETHIA_DATABASE_URL and prints the counts. Exits non-zero on failure. */
async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	if ("error" in args) {
		console.error(`✗ ${args.error}`);
		process.exit(1);
	}
	const url = process.env.ALETHIA_DATABASE_URL;
	if (!url) {
		console.error("✗ ALETHIA_DATABASE_URL is not set.");
		process.exit(1);
	}
	const batch = Number(process.env.PLAN_METADATA_BATCH || "500") || 500;
	const opts: BackfillOptions = {
		apply: args.apply,
		batch,
		keyConfigured: Boolean(process.env.ALETHIA_SNAPSHOT_HMAC_KEY),
	};
	console.log(`→ plan metadata backfill, ${opts.apply ? "APPLY" : "dry run"} (batch ${batch})…`);
	const sql = postgres(url, { max: 1, onnotice: () => {} });
	try {
		const db = postgresDb(sql, opts.apply);
		const plans = await backfillPlanRows(db, opts);
		console.log(formatCounts("PLAN plan_result", plans, opts.apply));
		const audits = await backfillAuditRows(db, opts);
		console.log(formatCounts("AUDIT audit_input", audits, opts.apply));
		await sql.end();
		if (plans.raced + audits.raced > 0) console.log("  (raced rows changed in between; run again to settle them)");
		if (!opts.apply) console.log("  dry run: nothing was written. Re-run with --apply to write.");
		console.log("✓ done");
		process.exit(0);
	} catch (err) {
		console.error("\n✗ the backfill failed:\n");
		console.error(err instanceof Error ? err.message : "unknown error");
		await sql.end({ timeout: 1 }).catch(() => {});
		process.exit(1);
	}
}

// Only run the pass when invoked directly, not when a test imports the functions above.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	void main();
}
