// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The staff app's read-only view of console tables (@repo/platform/console-refs) must match the
// console's real schema.
//
// The staff app is moving to its own repository and will install those refs from npm. After that, a
// console migration that renamed, dropped, retyped or made nullable a column the staff app reads
// would pass every check here and break the staff app in production. This test is the one place
// that sees both sides: for every column a ref declares, the console's table must have a column of
// the same physical name, with the same SQL type, and NOT NULL wherever the ref says NOT NULL (the
// staff app's types assume a value there).
//
// Names are resolved the way both apps resolve them at runtime: drizzle's own snake_case casing,
// not a re-implementation of it.

import { CasingCache } from "drizzle-orm/casing";
import {
	type AnyPgColumn,
	type AnyPgTable,
	getTableConfig,
	pgEnum,
	pgTable,
	text,
	uuid,
} from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import * as consoleSchema from "@/lib/db/schema";
import * as refs from "@repo/platform/console-refs";

/**
 * A column's physical name, resolved by drizzle's own snake_case casing. A fresh cache per call: the
 * cache is keyed by table NAME, and a ref and the console table it mirrors share one, so a shared
 * cache would answer a ref column's name from the console table's columns.
 */
function physicalName(col: AnyPgColumn): string {
	return new CasingCache("snake_case").getColumnCasing(col);
}

/**
 * The values a Postgres enum column is constrained to, or undefined for any other column. Only a real
 * `pgEnum` column counts: `text({ enum })` also carries `enumValues`, but as a TypeScript-only hint
 * the database does not enforce.
 */
function enumValuesOf(col: AnyPgColumn): readonly string[] | undefined {
	return col.columnType === "PgEnumColumn" ? col.enumValues : undefined;
}

/** Every pgTable exported by a module, keyed by its SQL name. */
function tablesOf(mod: Record<string, unknown>): Map<string, ReturnType<typeof getTableConfig>> {
	const out = new Map<string, ReturnType<typeof getTableConfig>>();
	for (const value of Object.values(mod)) {
		let config: ReturnType<typeof getTableConfig>;
		try {
			// getTableConfig throws on anything that is not a pgTable; the schema barrel also exports
			// enums, types and helpers.
			config = getTableConfig(value as AnyPgTable);
		} catch {
			continue;
		}
		out.set(config.name, config);
	}
	return out;
}

/** Each way a ref can disagree with the console, as one line naming the table and column. */
export function contractViolations(
	refTables: Map<string, ReturnType<typeof getTableConfig>>,
	owner: Map<string, ReturnType<typeof getTableConfig>>,
): string[] {
	const out: string[] = [];
	for (const [name, ref] of refTables) {
		const real = owner.get(name);
		if (!real) {
			out.push(`${name}: the console has no such table`);
			continue;
		}
		const realColumns = new Map(real.columns.map((c) => [physicalName(c), c]));
		for (const col of ref.columns) {
			const physical = physicalName(col);
			const match = realColumns.get(physical);
			if (!match) {
				out.push(`${name}.${physical}: the console has no such column`);
				continue;
			}
			if (match.getSQLType() !== col.getSQLType()) {
				out.push(`${name}.${physical}: ref says ${col.getSQLType()}, the console has ${match.getSQLType()}`);
			}
			const refValues = enumValuesOf(col);
			const realValues = enumValuesOf(match);
			if (refValues && realValues && [...refValues].sort().join() !== [...realValues].sort().join()) {
				out.push(`${name}.${physical}: ref enum values [${refValues.join(", ")}], the console has [${realValues.join(", ")}]`);
			}
			if (col.notNull && !match.notNull) {
				out.push(`${name}.${physical}: ref says NOT NULL, the console allows NULL`);
			}
		}
	}
	return out;
}

describe("@repo/platform/console-refs matches the console schema", () => {
	const owner = tablesOf(consoleSchema);
	const refTables = tablesOf(refs);

	// A reflective test that stops finding tables passes trivially, so the inputs are checked first.
	it("finds both sides", () => {
		expect(owner.size).toBeGreaterThan(50);
		expect([...refTables.keys()].sort()).toEqual([
			"ai_usage_ledger",
			"member",
			"organization",
			"organization_billing",
			"user",
		]);
	});

	it("reports a missing table, a missing column, a type change, an enum change and a dropped NOT NULL", () => {
		const planted = tablesOf({
			gone: pgTable("no_such_table", { id: uuid() }),
			drifted: pgTable("organization", {
				noSuchColumn: text(),
				id: text(),
			}),
			loosened: pgTable("user", { name: text().notNull() }),
			renamed: pgTable("organization_billing", {
				plan: pgEnum("billing_plan", ["community", "pro", "enterprise"])().notNull(),
			}),
		});
		const found = contractViolations(planted, owner);
		expect(found).toEqual(
			expect.arrayContaining([
				"no_such_table: the console has no such table",
				"organization.no_such_column: the console has no such column",
				"organization.id: ref says text, the console has uuid",
				"user.name: ref says NOT NULL, the console allows NULL",
				"organization_billing.plan: ref enum values [community, pro, enterprise], the console has [community, team, enterprise]",
			]),
		);
		expect(found).toHaveLength(5);
	});

	it("has no column the console does not back", () => {
		expect(contractViolations(refTables, owner)).toEqual([]);
	});
});
