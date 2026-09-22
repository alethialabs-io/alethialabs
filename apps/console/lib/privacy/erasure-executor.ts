// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The half of an erasure that touches rows (#4854).
//
// `erasure-plan.ts` decides WHAT happens and is a pure function; this module is the only thing that
// does it. The split is the point: before this existed, `fulfilErasure` built a plan, wrote a
// tombstone, set the case to `fulfilled` and recorded "Erasure performed" — and deleted nothing.
// The record was false, and nothing in the codebase could tell, because the plan and the record
// agreed with each other and neither one agreed with the database.
//
// Three properties this module is built around:
//
//   · IT DOES WHAT THE REGISTER SAYS, AND ONLY THAT. Every statement is derived from a rule — the
//     table, the subject column and the placeholder all come from the register, and the drizzle
//     schema resolves them. A table nobody wrote a rule for is not touched, and a rule naming a
//     column that does not exist throws here rather than skipping silently.
//   · IT REPORTS ROWS, NOT RULES. The old counts were `plan.erase.length` — how many TABLES were
//     considered. A count of tables cannot distinguish "erased 412 rows" from "erased nothing",
//     which is exactly the distinction that was missing.
//   · IT REFUSES WHILE AN ORG ONLY THE SUBJECT CAN REACH STILL HAS LIVE RESOURCES — their personal
//     one, and every team org whose only active owner they are. See `findLiveResidency`; the
//     refusal is a maintainer ruling and a feature, not an edge case.
//
// `server-only`, and not `"use server"`: nothing here may become a POST-addressable action — every
// export of a `"use server"` module is an endpoint whether or not the product calls it, and these
// take the subject as a parameter. The one caller is `fulfilErasure`, which is gated on standing
// over the CASE — an admin of the organization it was RAISED IN, and never the subject, who is not
// the second party to their own erasure (see `actions/privacy/cases.ts`). It runs on the
// RLS-bypassing service connection because an erasure crosses every tenancy boundary a subject's
// rows sit behind.

import "server-only";
import { randomUUID } from "node:crypto";
import { and, count, eq, inArray, is, ne, sql, type SQL } from "drizzle-orm";
import { toSnakeCase } from "drizzle-orm/casing";
import { getTableConfig, type PgColumn, PgTable } from "drizzle-orm/pg-core";
import type { Tx } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { toPdpRole } from "@/lib/authz/org-access-control";
import {
	cloudIdentities,
	member,
	projectEnvironments,
	projects,
} from "@/lib/db/schema";
import {
	type ErasurePlan,
	type ErasureRule,
	NIL_UUID,
	type Placeholder,
	REDACTED_MARKER,
} from "./erasure-plan";

/**
 * The slice of a drizzle transaction the row-touching half needs: one method that runs a statement.
 *
 * Narrower than `Tx` on purpose, and NOT to make the executor mockable for its own sake. A
 * parameter typed as the whole transaction is a parameter through which anything can be done, and
 * the one property worth being able to state about this module is the one a reader can then check:
 * the ONLY thing it does to the database is run the statements the register produced.
 */
export interface ErasureRunner {
	execute(query: SQL): Promise<unknown>;
}

/** The two identifiers a rule's subject column can hold. A personal org's id IS the user's id. */
export interface ErasureSubject {
	readonly userId: string;
	/** The subject's personal organization — the same uuid as `userId`, named for what it means. */
	readonly personalOrgId: string;
}

/** How many rows one rule actually touched. */
export interface ErasureTableResult {
	readonly table: string;
	readonly disposition: ErasureRule["disposition"];
	readonly rows: number;
}

/** What the executor did, in rows. */
export interface ErasureExecution {
	readonly tables: ErasureTableResult[];
	readonly rowsErased: number;
	readonly rowsPseudonymized: number;
}

// ── The subject's live estate ────────────────────────────────────────────────────────────────────

/**
 * What the organizations the subject ALONE can reach still own.
 *
 * A personal org's id is the user's id, so erasing the owner reaches projects, tofu state, live
 * cloud resources and OpenFGA tuples — none of which this module destroys or detaches.
 *
 * ⚠️ AND THE PERSONAL ORG IS NOT THE ONLY ONE. This counted only the personal org until the
 * security review of #4854, and the omission produced exactly the outcome the count exists to
 * prevent. The erasure deletes `session` and `account` and rewrites `user.email` to an address in
 * a reserved-for-invalid domain, so the account can never sign in again; `member` carries no rule,
 * so the subject stays the owner of every team organization they own. A team org whose ONLY active
 * owner is the subject therefore ends up with live infrastructure and no account able to reach,
 * bill or tear it down — the same hazard, one tenancy across.
 */
export interface ErasureResidency {
	/** Rows in `projects`, over every org in scope. A project is destroyed by removing it. */
	readonly projects: number;
	/** Environments not in the terminal `DESTROYED` state. */
	readonly environments: number;
	/** Connected cloud accounts. While one exists, resources may be live behind it. */
	readonly cloudConnections: number;
	/**
	 * How many of the counted rows' organizations are TEAM orgs the subject is the only active
	 * owner of — so the refusal can name the one action that clears them, which is not "delete
	 * every project" but "transfer ownership, or delete the organization".
	 */
	readonly soleOwnedOrganizations: number;
}

/** True when nothing is left and an erasure may proceed. */
export function residencyIsClear(r: ErasureResidency): boolean {
	return r.projects === 0 && r.environments === 0 && r.cloudConnections === 0;
}

/**
 * The organizations whose resources an erasure would strand: the subject's personal org, plus
 * every team org whose only ACTIVE OWNER is the subject.
 *
 * ⚠️ THE ROLE IS NOT A SQL EQUALITY. `member.role` is text and Better Auth's org plugin stores a
 * comma-joined list for a multi-role invite (`"owner,admin"` is a legitimate value, and the plugin
 * itself reads it back with a split) — so `role = 'owner'` misses a real owner. `toPdpRole`
 * resolves the most-privileged component, which is the same answer the PDP grants from.
 *
 * An org with a SUSPENDED second owner counts as sole-owned: a suspended member holds the role and
 * not the access (`lib/db/schema/organizations.ts`), so they cannot tear anything down either.
 */
async function strandedOrgIds(tx: Tx, subject: ErasureSubject): Promise<string[]> {
	const mine = await tx
		.select({ orgId: member.organizationId, role: member.role })
		.from(member)
		.where(and(eq(member.userId, subject.userId), eq(member.status, "active")));
	const owned = mine
		.filter((m) => toPdpRole(m.role) === "owner")
		.map((m) => m.orgId);
	if (owned.length === 0) return [subject.personalOrgId];

	const others = await tx
		.select({ orgId: member.organizationId, userId: member.userId, role: member.role })
		.from(member)
		.where(and(inArray(member.organizationId, owned), eq(member.status, "active")));
	const coOwned = new Set(
		others
			.filter((m) => m.userId !== subject.userId && toPdpRole(m.role) === "owner")
			.map((m) => m.orgId),
	);
	return [
		subject.personalOrgId,
		...owned.filter((id) => !coOwned.has(id) && id !== subject.personalOrgId),
	];
}

/**
 * Counts what those organizations still hold.
 *
 * ⚠️ THE MEASUREMENT IS DELIBERATELY BROADER THAN "a running server", and errs towards refusing.
 * `cloudConnections` counts credential anchors, not resources: while a connection exists we cannot
 * know from here what is live behind it, and the executor never detaches a credential — so an
 * account with a connector and no projects is refused too, and the message says to disconnect it.
 * Over-refusing costs the subject another step; under-refusing erases the only account that can
 * reach — or be billed for — infrastructure that is still running.
 *
 * `DESTROYED` is the one environment state that does not count: it is the terminal state a teardown
 * leaves behind, so counting it would make an org that HAS been torn down permanently un-erasable.
 * Every other state, `FAILED` included, counts — a failed destroy is the case where something is
 * most likely still running.
 *
 * ⚠️ WHAT IT DOES NOT ASK, stated because the bound is a decision and not an oversight: a
 * sole-owned organization holding NOTHING does not block. The maintainer's ruling is about
 * infrastructure left running, and an empty org has none — it is orphaned, which is a membership
 * question (who inherits it, is it deleted) that nobody has ruled on and that this step must not
 * decide by refusing.
 *
 * Read inside the caller's transaction so the count and the deletes see one snapshot; checking
 * outside would leave a window in which a project is created between the check and the erasure.
 */
export async function findLiveResidency(
	tx: Tx,
	subject: ErasureSubject,
): Promise<ErasureResidency> {
	const orgIds = await strandedOrgIds(tx, subject);
	/**
	 * Folds one grouped count into a total and the orgs that contributed.
	 *
	 * `org_id` is nullable on all three tables, so the row type is too. An `inArray` predicate can
	 * never match NULL, so no such row reaches here — the filter is what makes that a statement the
	 * type system holds rather than one a reader has to reconstruct.
	 */
	const byOrg = (
		rows: { orgId: string | null; n: number }[],
	): { total: number; orgs: string[] } => {
		const named = rows.filter(
			(r): r is { orgId: string; n: number } => r.orgId !== null,
		);
		return {
			total: named.reduce((sum, r) => sum + r.n, 0),
			orgs: named.filter((r) => r.n > 0).map((r) => r.orgId),
		};
	};

	const p = byOrg(
		await tx
			.select({ orgId: projects.org_id, n: count() })
			.from(projects)
			.where(inArray(projects.org_id, orgIds))
			.groupBy(projects.org_id),
	);
	const e = byOrg(
		await tx
			.select({ orgId: projectEnvironments.org_id, n: count() })
			.from(projectEnvironments)
			.where(
				and(
					inArray(projectEnvironments.org_id, orgIds),
					ne(projectEnvironments.status, "DESTROYED"),
				),
			)
			.groupBy(projectEnvironments.org_id),
	);
	const c = byOrg(
		await tx
			.select({ orgId: cloudIdentities.org_id, n: count() })
			.from(cloudIdentities)
			.where(inArray(cloudIdentities.org_id, orgIds))
			.groupBy(cloudIdentities.org_id),
	);

	// Which of the BLOCKING organizations are team orgs rather than the personal one. Counted from
	// the rows that actually blocked, so an empty sole-owned org is not reported as a thing to fix.
	const blocking = new Set([...p.orgs, ...e.orgs, ...c.orgs]);
	blocking.delete(subject.personalOrgId);
	return {
		projects: p.total,
		environments: e.total,
		cloudConnections: c.total,
		soleOwnedOrganizations: blocking.size,
	};
}

/**
 * The refusal, in words the subject can act on.
 *
 * A refusal the subject cannot act on is a refusal they have to write back about, which restarts
 * the correspondence inside a statutory month. So it names each thing that is still there, how many
 * there are, and the one action that clears it.
 */
export function describeResidency(r: ErasureResidency): string {
	const parts: string[] = [];
	if (r.projects > 0) {
		parts.push(`${r.projects} project${r.projects === 1 ? "" : "s"}`);
	}
	if (r.environments > 0) {
		parts.push(
			`${r.environments} environment${r.environments === 1 ? "" : "s"} that have not been destroyed`,
		);
	}
	if (r.cloudConnections > 0) {
		parts.push(
			`${r.cloudConnections} connected cloud account${r.cloudConnections === 1 ? "" : "s"}`,
		);
	}
	const where =
		r.soleOwnedOrganizations > 0
			? `the account's organizations still have ${parts.join(", ")}, ` +
				`across ${r.soleOwnedOrganizations} organization${r.soleOwnedOrganizations === 1 ? "" : "s"} ` +
				"it is the only owner of and its own personal organization"
			: `the account's personal organization still has ${parts.join(", ")}`;
	const clear =
		r.soleOwnedOrganizations > 0
			? "Destroy every environment, delete every project and disconnect every cloud account — and " +
				"for an organization somebody else should keep, make somebody else an owner of it instead. "
			: "Destroy every environment, delete every project and disconnect every cloud account, ";
	return (
		`Erasure is not performed while ${where}. ` +
		"Erasing the owner would leave infrastructure running that nothing can reach, bill or tear down, " +
		"and this step never destroys cloud resources, never transfers them to somebody else and never " +
		"changes who owns an organization. " +
		`${clear}then ask ` +
		"for the request to be fulfilled again. The request stays open and its deadline is unchanged."
	);
}

// ── Resolving a rule against the real schema ─────────────────────────────────────────────────────

/**
 * Every table in the drizzle schema, by its Postgres name.
 *
 * Built from the schema barrel rather than a hand-written map: a hand-written one is a second list
 * that can disagree with the schema, which is the defect this issue is about.
 */
let tablesByName: Map<string, PgTable> | null = null;

/** The schema's tables, indexed by Postgres name. Built once. */
function schemaTables(): Map<string, PgTable> {
	if (tablesByName) return tablesByName;
	const index = new Map<string, PgTable>();
	for (const value of Object.values(schema)) {
		if (!is(value, PgTable)) continue;
		index.set(getTableConfig(value).name, value);
	}
	tablesByName = index;
	return index;
}

/**
 * The column's name IN POSTGRES.
 *
 * Most columns here are declared without one (`userId: uuid()`), so drizzle holds the PROPERTY key
 * and converts it at query time from the connection's `casing: "snake_case"`. `column.name` is
 * therefore `userId`, not `user_id` — so a register written in Postgres names would match nothing
 * if it compared against `.name` directly, and every rule would silently resolve to no column.
 */
export function columnSqlName(column: PgColumn): string {
	return column.keyAsName ? toSnakeCase(column.name) : column.name;
}

/** A rule's table, or a throw naming what the register asked for. */
function resolveTable(rule: ErasureRule): PgTable {
	const table = schemaTables().get(rule.table);
	if (!table) {
		throw new Error(
			`The erasure register names a table that is not in the schema: ${rule.table}.`,
		);
	}
	return table;
}

/** One column of a rule's table, or a throw naming what the register asked for. */
function resolveColumn(rule: ErasureRule, columnName: string): PgColumn {
	const table = resolveTable(rule);
	const column = getTableConfig(table).columns.find(
		(c) => columnSqlName(c) === columnName,
	);
	if (!column) {
		throw new Error(
			`The erasure register names ${rule.table}.${columnName}, which is not a column of ${rule.table}.`,
		);
	}
	return column;
}

/**
 * What a placeholder writes.
 *
 * `erased_email` is generated per call because `user.email` is UNIQUE: a fixed marker would collide
 * with the previous erasure and abort the transaction, so the second person to ask would be refused
 * by a constraint rather than by a decision. `.invalid` is reserved by RFC 2606 and resolves
 * nowhere, so the address can never be delivered to, signed in with, or mistaken for a real one.
 */
export function placeholderValue(kind: Placeholder): string | null {
	switch (kind) {
		case "null":
			return null;
		case "redacted":
			return REDACTED_MARKER;
		case "nil_uuid":
			return NIL_UUID;
		case "erased_email":
			return `erased-${randomUUID()}@erased.invalid`;
	}
}

/**
 * The statement one rule runs, or null for a `retain` rule.
 *
 * `RETURNING 1` is what makes the row count real: the alternative is trusting a driver-specific
 * `rowCount`, and the count is the only thing that distinguishes this executor from the one that
 * reported success while doing nothing.
 *
 * Identifiers come from the drizzle schema — never from the register string — so a register entry
 * cannot introduce SQL; values are bound parameters.
 */
export function statementFor(rule: ErasureRule, subject: ErasureSubject): SQL | null {
	if (rule.disposition === "retain") return null;

	const table = resolveTable(rule);
	const subjectColumn = resolveColumn(rule, rule.subjectColumn);
	const subjectValue =
		rule.subject === "personal_org" ? subject.personalOrgId : subject.userId;
	const where = sql`${sql.identifier(columnSqlName(subjectColumn))} = ${subjectValue}`;

	if (rule.disposition === "erase") {
		return sql`delete from ${table} where ${where} returning 1`;
	}

	const columns = rule.pseudonymize ?? [];
	if (columns.length === 0) {
		// A pseudonymize rule with no columns overwrites nothing and would report the rows as
		// handled. Refusing is the only outcome that does not produce a false record.
		throw new Error(
			`The erasure register's ${rule.table} rule pseudonymizes no columns, so it would leave the ` +
				"identifier in place while reporting the row as handled.",
		);
	}
	const assignments = columns.map((c) => {
		const column = resolveColumn(rule, c.column);
		if (c.with === "null" && column.notNull) {
			throw new Error(
				`The erasure register sets ${rule.table}.${c.column} to null, but the column is NOT NULL.`,
			);
		}
		return sql`${sql.identifier(columnSqlName(column))} = ${placeholderValue(c.with)}`;
	});
	return sql`update ${table} set ${sql.join(assignments, sql`, `)} where ${where} returning 1`;
}

// ── Doing it ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Applies the plan, in the register's order, inside the caller's transaction.
 *
 * ONE TRANSACTION, and the caller's: a partial erasure is the worst outcome available — the subject
 * is told their data is gone while some of it is not, and there is no record of which half. The
 * tombstone and the ledger event are written by the same transaction, so either everything happened
 * and is recorded or nothing did.
 *
 * The order is the register's array order and is never sorted; `erasure-plan.ts` explains which
 * orderings are load-bearing.
 */
export async function applyErasurePlan(
	tx: ErasureRunner,
	plan: ErasurePlan,
	subject: ErasureSubject,
): Promise<ErasureExecution> {
	const tables: ErasureTableResult[] = [];
	let rowsErased = 0;
	let rowsPseudonymized = 0;

	for (const rule of [...plan.erase, ...plan.pseudonymize]) {
		const statement = statementFor(rule, subject);
		if (!statement) continue;
		const result = await tx.execute(statement);
		const rows = Array.isArray(result) ? result.length : 0;
		tables.push({ table: rule.table, disposition: rule.disposition, rows });
		if (rule.disposition === "erase") rowsErased += rows;
		else rowsPseudonymized += rows;
	}

	return { tables, rowsErased, rowsPseudonymized };
}
