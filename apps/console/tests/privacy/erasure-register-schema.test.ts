// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The erasure register, checked against the REAL drizzle schema (#4854).
//
// `erasure-plan.test.ts` checks the register's internal invariants — every rule has a reason, a
// retained table cites an obligation, a hold pauses rather than refuses. All of that passed for
// months while FOUR of the nine rules named a table or a column that does not exist:
// `invoices.issued_to_user_id` (the table is `invoice`, org-scoped, and has no user column),
// `support_messages.author_user_id` (the column is `author_id`), `cli_logins.user_id` (it is
// `profile_id`) and `audit_log.actor_user_id` (it is `user_id`, and NOT NULL, so the `null` the
// register asked for could not have been written either).
//
// Nothing could catch that, because the register was a list of STRINGS that nothing resolved. Now
// the executor resolves every one of them against the schema, so this file is the test that fails
// at build time instead of inside an erasure transaction on a real person's account.
//
// What is asserted, and why each one is a defect the previous suite could not see:
//
//   · every rule's table exists in the drizzle schema;
//   · every rule's subject column exists ON that table;
//   · every pseudonymize column exists, and its PLACEHOLDER FITS the column — `null` only on a
//     nullable column, `nil_uuid` only on a uuid, `redacted`/`erased_email` only on text;
//   · a pseudonymize rule never overwrites a primary key without declaring why it is kept;
//   · the erase order respects the foreign keys that have no ON DELETE — the register listed
//     `profiles` before `cli_logins`, which references it, so the first real run would have died
//     on the constraint.

import { getTableConfig, type PgColumn, PgTable } from "drizzle-orm/pg-core";
import { is } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import * as schema from "@/lib/db/schema";
import { columnSqlName } from "@/lib/privacy/erasure-executor";
import { ERASURE_RULES } from "@/lib/privacy/erasure-plan";

/** Every table in the schema barrel, by its Postgres name. */
const TABLES = new Map<string, PgTable>();
for (const value of Object.values(schema)) {
	if (is(value, PgTable)) TABLES.set(getTableConfig(value).name, value);
}

/** The columns of `name`, by their Postgres name. Throws if the table is unknown. */
function columnsOf(name: string): Map<string, PgColumn> {
	const table = TABLES.get(name);
	if (!table) throw new Error(`no such table: ${name}`);
	const out = new Map<string, PgColumn>();
	for (const c of getTableConfig(table).columns) out.set(columnSqlName(c), c);
	return out;
}

describe("the erasure register against the schema", () => {
	// The sanity check on the harness itself: if the barrel scan found nothing, every assertion
	// below would pass vacuously by never entering its loop.
	it("finds the schema's tables at all", () => {
		expect(TABLES.size).toBeGreaterThan(50);
		expect(TABLES.has("user")).toBe(true);
		expect(TABLES.has("audit_log")).toBe(true);
	});

	it.each(ERASURE_RULES.map((r) => [r.table, r] as const))(
		"%s: the table exists and carries the subject column the rule names",
		(_name, rule) => {
			expect(TABLES.has(rule.table)).toBe(true);
			const columns = columnsOf(rule.table);
			expect([...columns.keys()]).toContain(rule.subjectColumn);
		},
	);

	it.each(
		ERASURE_RULES.filter((r) => r.disposition === "pseudonymize").map(
			(r) => [r.table, r] as const,
		),
	)("%s: every overwritten column exists and accepts its placeholder", (_name, rule) => {
		const columns = columnsOf(rule.table);
		expect(rule.pseudonymize?.length ?? 0).toBeGreaterThan(0);
		for (const { column, with: kind } of rule.pseudonymize ?? []) {
			const col = columns.get(column);
			expect(col, `${rule.table}.${column} is not a column`).toBeDefined();
			if (!col) continue;
			// A `null` placeholder on a NOT NULL column is a not-null violation INSIDE the erasure
			// transaction — the register's own `audit_log` and `authz_activity_log` rules both asked
			// for exactly that before #4854.
			if (kind === "null") expect(col.notNull).toBe(false);
			if (kind === "nil_uuid") expect(col.columnType).toBe("PgUUID");
			if (kind === "redacted" || kind === "erased_email") {
				expect(col.columnType).toBe("PgText");
			}
			// `erased_email` generates a fresh value per erasure precisely because the column is
			// unique; using it on a non-unique column would be pointless, and a fixed marker on a
			// unique one collides on the SECOND erasure.
			if (kind === "erased_email") expect(col.isUnique).toBe(true);
		}
	});

	// The subject column is normally overwritten — that IS the unlink. `user.id` is the exception:
	// it is the key the retained statutory records point at. Checked in BOTH directions so the
	// declaration cannot be left behind on a rule that does overwrite its key.
	it("only leaves a subject column in place where the rule says why, and never a plain column", () => {
		for (const rule of ERASURE_RULES.filter((r) => r.disposition === "pseudonymize")) {
			const overwritesSubject =
				rule.pseudonymize?.some((c) => c.column === rule.subjectColumn) ?? false;
			if (overwritesSubject) {
				expect(rule.keyRetainedBecause).toBeUndefined();
				continue;
			}
			expect(rule.keyRetainedBecause?.length ?? 0).toBeGreaterThan(40);
			// And the only column that may be left in place is a PRIMARY KEY. Leaving an ordinary
			// foreign key behind would be a rule that says it unlinked a row and did not.
			const col = columnsOf(rule.table).get(rule.subjectColumn);
			expect(col?.primary).toBe(true);
		}
	});

	// The executor runs the register's array order verbatim. Where a reference carries no
	// ON DELETE, Postgres refuses to delete the parent while a child points at it, so a child's
	// rule has to come first. The register had `profiles` before `cli_logins`.
	//
	// DERIVED FROM THE SCHEMA, not a hand-written pair list. The two pairs this replaces were the
	// two blocking edges that exist TODAY; a hand-written list says nothing about the next erase
	// rule, and the ordering it protects is exactly the kind a new rule gets wrong. Walking the
	// foreign keys asks the question the constraint will actually ask.
	it("erases a child before the parent it references with no ON DELETE", () => {
		const eraseOrder = ERASURE_RULES.filter((r) => r.disposition === "erase").map(
			(r) => r.table,
		);
		// `undefined` is Postgres's default NO ACTION, which blocks exactly like `restrict`.
		const blocks = (onDelete: string | undefined) =>
			onDelete === undefined || onDelete === "no action" || onDelete === "restrict";

		const edges: [string, string][] = [];
		for (const child of eraseOrder) {
			const table = TABLES.get(child);
			if (!table) continue;
			for (const fk of getTableConfig(table).foreignKeys) {
				const ref = fk.reference();
				const parent = getTableConfig(ref.foreignTable).name;
				if (parent === child) continue;
				if (eraseOrder.includes(parent) && blocks(fk.onDelete)) {
					edges.push([child, parent]);
				}
			}
		}
		// The harness has to have found something, or every assertion below is vacuous — and a
		// vacuous ordering test is how the `profiles`/`cli_logins` inversion survived.
		expect(edges.length).toBeGreaterThan(0);
		for (const [child, parent] of edges) {
			expect(
				eraseOrder.indexOf(child),
				`${child} references ${parent} with no ON DELETE, so it must be erased first`,
			).toBeLessThan(eraseOrder.indexOf(parent));
		}
	});

	// The other half of the same constraint, and the half no ordering can fix: a table OUTSIDE the
	// erase set that points at one INSIDE it with a blocking rule makes the delete impossible
	// however the register is ordered. Today the only inbound references cascade
	// (`agent_threads`) or set null (`profiles` ← `cli_service_tokens`); a new blocking one is a
	// rule that has to be added, not reordered.
	it("has no blocking reference into an erased table from outside the erase set", () => {
		const eraseSet = new Set(
			ERASURE_RULES.filter((r) => r.disposition === "erase").map((r) => r.table),
		);
		const offenders: string[] = [];
		for (const [name, table] of TABLES) {
			if (eraseSet.has(name)) continue;
			for (const fk of getTableConfig(table).foreignKeys) {
				const parent = getTableConfig(fk.reference().foreignTable).name;
				const onDelete = fk.onDelete;
				const blocks =
					onDelete === undefined ||
					onDelete === "no action" ||
					onDelete === "restrict";
				if (eraseSet.has(parent) && blocks) offenders.push(`${name} → ${parent}`);
			}
		}
		expect(offenders).toEqual([]);
	});

	// The `profiles` rule claims a consequence beyond its own table: erasing that row revokes every
	// service token the subject minted. Half of that is this constraint; the other half is
	// `verifyCliToken` refusing a token whose `createdBy` is null, which
	// `tests/lib/cli/service-token-pin.test.ts` already locks. Asserted because it is the reason
	// `cli_service_tokens` is absent from the register, and an absence justified by an unchecked
	// sentence is how a live credential outlives the account it speaks for.
	it("revokes the subject's service tokens by erasing the profile they point at", () => {
		const profilesRule = ERASURE_RULES.find((r) => r.table === "profiles");
		expect(profilesRule?.disposition).toBe("erase");
		expect(profilesRule?.subjectColumn).toBe("id");
		const fk = getTableConfig(
			TABLES.get("cli_service_tokens") ?? ({} as PgTable),
		).foreignKeys.map((f) => {
			const ref = f.reference();
			return {
				columns: ref.columns.map(columnSqlName),
				table: getTableConfig(ref.foreignTable).name,
				onDelete: f.onDelete,
			};
		});
		expect(fk).toContainEqual({
			columns: ["created_by"],
			table: "profiles",
			onDelete: "set null",
		});
	});

	// The reason this executor pseudonymizes the account row instead of deleting it. Both
	// constraints are deliberate and both must keep holding, because either one alone turns a
	// `DELETE FROM "user"` into a silent loss (the cascade) or a hard failure (the restrict).
	it("keeps the two constraints that make deleting the user row the wrong plan", () => {
		const fks = (table: string) =>
			getTableConfig(TABLES.get(table) ?? ({} as PgTable)).foreignKeys.map((fk) => {
				const ref = fk.reference();
				return {
					columns: ref.columns.map(columnSqlName),
					table: getTableConfig(ref.foreignTable).name,
					onDelete: fk.onDelete,
				};
			});
		expect(fks("legal_acceptance")).toContainEqual({
			columns: ["user_id"],
			table: "user",
			onDelete: "cascade",
		});
		expect(fks("commerce_order")).toContainEqual({
			columns: ["placed_by_user_id"],
			table: "user",
			onDelete: "restrict",
		});
	});
});
