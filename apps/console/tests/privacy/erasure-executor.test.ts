// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The half of an erasure that touches rows (#4854).
//
// The defect this replaces is the reason these assertions are about SQL and ROW COUNTS and not
// about the function returning without throwing. `fulfilErasure` used to return
// `{ erased: 6, pseudonymized: 3, retained: 3 }` — counts of TABLES CONSIDERED — while issuing no
// statement at all, and nothing in the suite could tell the difference. A test here that only
// checked "it resolved" would reproduce exactly that.
//
// So every test below asserts on something a no-op executor would fail: the rendered statement and
// its bound parameters, the number of statements, the order they went in, and the rows each one
// reported back.

import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
	applyErasurePlan,
	describeResidency,
	type ErasureRunner,
	placeholderValue,
	residencyIsClear,
	statementFor,
} from "@/lib/privacy/erasure-executor";
import {
	buildErasurePlan,
	ERASURE_RULES,
	type ErasureRule,
	NIL_UUID,
	REDACTED_MARKER,
} from "@/lib/privacy/erasure-plan";

const SUBJECT = {
	userId: "11111111-1111-1111-1111-111111111111",
	personalOrgId: "11111111-1111-1111-1111-111111111111",
};
const OTHER_ORG = "22222222-2222-2222-2222-222222222222";

const dialect = new PgDialect();

/** The statement as Postgres would receive it: the text, and the values bound to it. */
function render(query: SQL): { sql: string; params: unknown[] } {
	const q = dialect.sqlToQuery(query);
	return { sql: q.sql, params: q.params };
}

/** The rule the register holds for `table`, or a throw — so a renamed rule fails loudly here. */
function ruleFor(table: string): ErasureRule {
	const rule = ERASURE_RULES.find((r) => r.table === table);
	if (!rule) throw new Error(`the register has no rule for ${table}`);
	return rule;
}

/** A runner that records every statement and answers with `rows` rows for each. */
function recorder(rows = 1): ErasureRunner & { seen: { sql: string; params: unknown[] }[] } {
	const seen: { sql: string; params: unknown[] }[] = [];
	return {
		seen,
		execute: async (query: SQL) => {
			seen.push(render(query));
			return new Array(rows).fill({ "?column?": 1 });
		},
	};
}

describe("the statement one rule runs", () => {
	it("deletes the subject's rows, matched on the column the register names", () => {
		const statement = statementFor(ruleFor("agent_threads"), SUBJECT);
		expect(statement).not.toBeNull();
		if (!statement) return;
		const { sql, params } = render(statement);
		expect(sql).toBe('delete from "agent_threads" where "user_id" = $1 returning 1');
		expect(params).toEqual([SUBJECT.userId]);
	});

	it("overwrites every column a pseudonymize rule names, and nothing else", () => {
		const statement = statementFor(ruleFor("support_messages"), SUBJECT);
		expect(statement).not.toBeNull();
		if (!statement) return;
		const { sql, params } = render(statement);
		expect(sql).toBe(
			'update "support_messages" set "author_id" = $1, "author_name" = $2, "body" = $3 ' +
				'where "author_id" = $4 returning 1',
		);
		// The author is unlinked, the display-name SNAPSHOT goes with it (unlinking the id alone
		// would leave the subject's name in plaintext), and the body is replaced rather than deleted.
		expect(params).toEqual([null, null, REDACTED_MARKER, SUBJECT.userId]);
	});

	// The column is NOT NULL and carries no foreign key, so the unlink cannot be a null.
	it("unlinks a NOT NULL uuid with the nil uuid", () => {
		const statement = statementFor(ruleFor("audit_log"), SUBJECT);
		if (!statement) throw new Error("audit_log produced no statement");
		const { sql, params } = render(statement);
		expect(sql).toBe('update "audit_log" set "user_id" = $1 where "user_id" = $2 returning 1');
		expect(params).toEqual([NIL_UUID, SUBJECT.userId]);
	});

	// The account row: its CONTENT is erased and its key is kept, because the retained statutory
	// records point at the key. A statement that touched `id` would break them.
	it("erases the account row's content and never its key", () => {
		const statement = statementFor(ruleFor("user"), SUBJECT);
		if (!statement) throw new Error("user produced no statement");
		const { sql, params } = render(statement);
		expect(sql).toBe(
			'update "user" set "email" = $1, "name" = $2, "image" = $3, "username" = $4 ' +
				'where "id" = $5 returning 1',
		);
		expect(params[0]).toMatch(/^erased-[0-9a-f-]{36}@erased\.invalid$/);
		expect(params.slice(1)).toEqual([null, null, null, SUBJECT.userId]);
		expect(sql).not.toContain('set "id"');
	});

	it("runs nothing at all for a retained table", () => {
		for (const rule of ERASURE_RULES.filter((r) => r.disposition === "retain")) {
			expect(statementFor(rule, SUBJECT)).toBeNull();
		}
	});

	// `invoice` is org-scoped and is why the register distinguishes the two identifiers at all.
	// Asserted on an `erase` rule because a `retain` rule renders nothing to look at.
	it("binds a personal_org rule to the organization id, not the user id", () => {
		const statement = statementFor(
			{
				table: "invoice",
				subjectColumn: "organization_id",
				subject: "personal_org",
				disposition: "erase",
				reason: "A synthetic rule, to pin which identifier the subject key selects.",
			},
			{ userId: SUBJECT.userId, personalOrgId: OTHER_ORG },
		);
		if (!statement) throw new Error("no statement");
		expect(render(statement).params).toEqual([OTHER_ORG]);
	});
});

describe("what the executor refuses to build", () => {
	const base = { disposition: "erase", reason: "x".repeat(50) } as const;

	it("refuses a table that is not in the schema, naming it", () => {
		expect(() =>
			statementFor({ ...base, table: "invoices", subjectColumn: "issued_to_user_id" }, SUBJECT),
		).toThrow(/invoices/);
	});

	it("refuses a column that is not on the table, naming it", () => {
		expect(() =>
			statementFor({ ...base, table: "support_messages", subjectColumn: "author_user_id" }, SUBJECT),
		).toThrow(/support_messages\.author_user_id/);
	});

	// This is what the register asked for before #4854, on two tables. Postgres would have raised
	// it mid-transaction, on a real person's erasure.
	it("refuses to write null into a NOT NULL column", () => {
		expect(() =>
			statementFor(
				{
					table: "audit_log",
					subjectColumn: "user_id",
					disposition: "pseudonymize",
					reason: "x".repeat(50),
					pseudonymize: [{ column: "user_id", with: "null" }],
				},
				SUBJECT,
			),
		).toThrow(/NOT NULL/);
	});

	// A rule that overwrites nothing would report its rows as handled while leaving the identifier
	// in place — the exact shape of the defect this issue is about, one rule smaller.
	it("refuses a pseudonymize rule that overwrites no column", () => {
		expect(() =>
			statementFor(
				{
					table: "support_messages",
					subjectColumn: "author_id",
					disposition: "pseudonymize",
					reason: "x".repeat(50),
					pseudonymize: [],
				},
				SUBJECT,
			),
		).toThrow(/pseudonymizes no columns/);
	});
});

describe("the email placeholder", () => {
	// `user.email` is UNIQUE. A fixed marker collides on the SECOND erasure — which would abort
	// that transaction and refuse the second person by constraint rather than by decision.
	it("is different every time, and undeliverable", () => {
		const a = placeholderValue("erased_email");
		const b = placeholderValue("erased_email");
		expect(a).not.toBe(b);
		// RFC 2606 reserves `.invalid`; it resolves nowhere and can never be signed in with.
		expect(a).toMatch(/@erased\.invalid$/);
	});

	it("keeps the other three placeholders fixed", () => {
		expect(placeholderValue("null")).toBeNull();
		expect(placeholderValue("redacted")).toBe(REDACTED_MARKER);
		expect(placeholderValue("nil_uuid")).toBe(NIL_UUID);
	});
});

describe("applying a plan", () => {
	it("issues one statement per erase and pseudonymize rule, in the register's order", async () => {
		const plan = buildErasurePlan();
		const tx = recorder(3);
		const result = await applyErasurePlan(tx, plan, SUBJECT);

		expect(tx.seen).toHaveLength(plan.erase.length + plan.pseudonymize.length);
		// The order is load-bearing: `cli_logins` references `profiles` with no ON DELETE, and
		// `oauth_access_token.refresh_id` references `oauth_refresh_token`. Sorting would break both.
		expect(result.tables.map((t) => t.table)).toEqual([
			...plan.erase.map((r) => r.table),
			...plan.pseudonymize.map((r) => r.table),
		]);
		// Every erase is a DELETE and every pseudonymize an UPDATE — a rule whose disposition and
		// statement disagreed would take rows a plan said it would only unlink.
		for (const [i, seen] of tx.seen.entries()) {
			const expected = i < plan.erase.length ? "delete from" : "update ";
			expect(seen.sql.startsWith(expected)).toBe(true);
		}
	});

	// THE assertion the old implementation fails. Rows, not tables.
	it("reports the rows each statement touched, not the number of tables", async () => {
		const plan = buildErasurePlan();
		const tx = recorder(3);
		const result = await applyErasurePlan(tx, plan, SUBJECT);

		expect(result.rowsErased).toBe(plan.erase.length * 3);
		expect(result.rowsPseudonymized).toBe(plan.pseudonymize.length * 3);
		expect(result.tables.every((t) => t.rows === 3)).toBe(true);
		// And a subject with nothing stored reports zero rather than the table count.
		const empty = await applyErasurePlan(recorder(0), plan, SUBJECT);
		expect(empty.rowsErased).toBe(0);
		expect(empty.rowsPseudonymized).toBe(0);
		expect(empty.tables).toHaveLength(plan.erase.length + plan.pseudonymize.length);
	});

	// A retained table is retained because a law says so. A statement against one is the failure
	// that cannot be walked back.
	it("never issues a statement against a retained table", async () => {
		const plan = buildErasurePlan();
		const tx = recorder();
		await applyErasurePlan(tx, plan, SUBJECT);
		for (const rule of plan.retain) {
			expect(tx.seen.some((s) => s.sql.includes(`"${rule.table}"`))).toBe(false);
		}
		// Named explicitly too, so a register that silently dropped one of them still fails here.
		for (const table of ["legal_acceptance", "commerce_order", "invoice", "authz_activity_log"]) {
			expect(tx.seen.some((s) => s.sql.includes(`"${table}"`))).toBe(false);
		}
	});

	// Under a hold the plan's destructive halves are empty, and the executor must not reach past
	// the plan to the register. Turning a pause into an erasure is unrecoverable.
	it("touches nothing under a legal hold", async () => {
		const tx = recorder();
		const result = await applyErasurePlan(
			tx,
			buildErasurePlan({ legalHoldReason: "Ongoing chargeback dispute" }),
			SUBJECT,
		);
		expect(tx.seen).toEqual([]);
		expect(result.rowsErased).toBe(0);
		expect(result.rowsPseudonymized).toBe(0);
	});

	// Every statement matches on the subject, and on nothing else. A rule whose WHERE lost its
	// binding would erase the table.
	it("binds the subject into every statement", async () => {
		const tx = recorder();
		await applyErasurePlan(tx, buildErasurePlan(), SUBJECT);
		for (const seen of tx.seen) {
			expect(seen.params).toContain(SUBJECT.userId);
			expect(seen.sql).toContain("where");
		}
	});
});

describe("the live-resources refusal", () => {
	const clear = {
		projects: 0,
		environments: 0,
		cloudConnections: 0,
		soleOwnedOrganizations: 0,
	};

	it("is clear only when all three counts are zero", () => {
		expect(residencyIsClear(clear)).toBe(true);
		expect(residencyIsClear({ ...clear, projects: 1 })).toBe(false);
		expect(residencyIsClear({ ...clear, environments: 1 })).toBe(false);
		expect(residencyIsClear({ ...clear, cloudConnections: 1 })).toBe(false);
	});

	// A refusal the subject cannot act on restarts the correspondence inside a statutory month, so
	// the message has to name what is there AND what clears it.
	it("names every kind that is still there, and the action that clears it", () => {
		const message = describeResidency({
			...clear,
			projects: 2,
			environments: 1,
			cloudConnections: 3,
		});
		expect(message).toContain("2 projects");
		expect(message).toContain("1 environment that");
		expect(message).toContain("3 connected cloud accounts");
		expect(message).toMatch(/destroy every environment/i);
		expect(message).toMatch(/the request stays open/i);
	});

	// The ENUMERATION lists only what is there. (The closing instruction names all three regardless
	// — it is what clears the refusal, not what triggered it — so the assertion is on the first
	// sentence, which is the half that varies.)
	it("enumerates only the kinds that are actually there", () => {
		const first = (r: Parameters<typeof describeResidency>[0]) =>
			describeResidency(r).split(". ")[0] ?? "";
		expect(first({ ...clear, projects: 1 })).toBe(
			"Erasure is not performed while the account's personal organization still has 1 project",
		);
		expect(first({ ...clear, cloudConnections: 1 })).toBe(
			"Erasure is not performed while the account's personal organization still has " +
				"1 connected cloud account",
		);
		expect(first({ ...clear, environments: 2 })).toBe(
			"Erasure is not performed while the account's personal organization still has " +
				"2 environments that have not been destroyed",
		);
	});
});
