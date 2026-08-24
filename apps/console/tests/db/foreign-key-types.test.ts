// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Every foreign key must have the SAME SQL type as the column it references.
//
// Written after #2372 shipped `legal_acceptance.user_id` as `text()` referencing `user.id`, which is
// `uuid()`. drizzle-kit generates that migration happily; TypeScript sees `string` on both sides and
// says nothing. Postgres refuses it — `foreign key constraint … cannot be implemented` — and the
// first thing that ran a real Postgres was CI, which meant a full red cycle for a one-word typo that
// was visible in the schema the whole time.
//
// This asks the same question for free, on every PR, over EVERY table: it walks the declared schema
// and compares each FK column's rendered SQL type with its referent's. `text` → `uuid` is the case
// that bit; `integer` → `bigint` and `varchar(n)` → `text` fail the same way.

import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import * as schema from "@/lib/db/schema";

interface Mismatch {
	table: string;
	column: string;
	columnType: string;
	referencedTable: string;
	referencedColumn: string;
	referencedType: string;
}

/** Every declared pgTable in the schema barrel, with its config. */
function declaredTables() {
	const out: { name: string; config: ReturnType<typeof getTableConfig> }[] = [];
	for (const value of Object.values(schema)) {
		let config: ReturnType<typeof getTableConfig>;
		try {
			// getTableConfig throws on anything that is not a pgTable — the barrel also exports enums,
			// types and helpers, and filtering by a `try` is more robust than by an `is()` check that
			// has to stay in step with drizzle's internals.
			config = getTableConfig(value as Parameters<typeof getTableConfig>[0]);
		} catch {
			continue;
		}
		out.push({ name: config.name, config });
	}
	return out;
}

describe("foreign keys match the type of what they reference", () => {
	const tables = declaredTables();

	// A parser that stops finding tables makes every assertion below pass trivially — the failure
	// mode of a reflective test, so it is checked first.
	it("finds the schema", () => {
		expect(tables.length).toBeGreaterThan(50);
		expect(tables.some((t) => t.name === "user")).toBe(true);
	});

	it("has no column whose SQL type differs from its referent's", () => {
		const mismatches: Mismatch[] = [];
		for (const { config } of tables) {
			for (const fk of config.foreignKeys) {
				const ref = fk.reference();
				ref.columns.forEach((col, i) => {
					const foreign = ref.foreignColumns[i];
					if (!foreign) return;
					if (col.getSQLType() !== foreign.getSQLType()) {
						mismatches.push({
							table: config.name,
							column: col.name,
							columnType: col.getSQLType(),
							referencedTable: foreign.table ? getTableConfig(foreign.table).name : "?",
							referencedColumn: foreign.name,
							referencedType: foreign.getSQLType(),
						});
					}
				});
			}
		}
		if (mismatches.length > 0) {
			const lines = mismatches
				.map(
					(m) =>
						`  ${m.table}.${m.column} is ${m.columnType}, but references ` +
						`${m.referencedTable}.${m.referencedColumn} which is ${m.referencedType}`,
				)
				.join("\n");
			throw new Error(
				`These foreign keys cannot be created by Postgres:\n\n${lines}\n\n` +
					`Both sides of a foreign key must have the same type. TypeScript will not catch this — ` +
					`uuid and text are both \`string\` to it — and drizzle-kit generates the migration anyway; ` +
					`the failure is "foreign key constraint … cannot be implemented" at migrate time.`,
			);
		}
		expect(mismatches).toEqual([]);
	});
});
