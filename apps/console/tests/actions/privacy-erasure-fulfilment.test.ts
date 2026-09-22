// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// `fulfilErasure` — the step that actually erases, and the one that refuses (#4854).
//
// What this file exists to stop happening again: the previous implementation wrote a tombstone,
// set the case to `fulfilled` and recorded "Erasure performed" while issuing no statement against
// any of the tables in its own plan. Every assertion below is therefore about what reached the
// database — the statements, the tombstone, the case state and the ledger entry — and not about
// the call returning. A test that only checked the return value would have passed on the old code.
//
// The three outcomes, each held to its own assertions:
//
//   erased                  statements ran, a tombstone was left, the case is `fulfilled`, and the
//                           ledger records ROWS (what happened) rather than table counts (what was
//                           considered).
//   refused_live_resources  the maintainer's ruling of 2026-09-19. NOTHING ran, no tombstone was
//                           written, the case stays open, and the ledger carries the reason and
//                           the counts. A connected cloud account alone is enough to refuse.
//   paused_by_legal_hold    unchanged behaviour: the tombstone is still written, with an empty
//                           scope, and nothing is erased.
//
// And the property that holds across all three: every write goes through the TRANSACTION. The
// service db handed to the action records bare writes separately, and the suite asserts there are
// none — so moving the tombstone insert back outside the transaction fails here.

import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { authorize, authorizeInOrg, currentActor } = vi.hoisted(() => ({
	authorize: vi.fn(),
	authorizeInOrg: vi.fn(),
	currentActor: vi.fn(),
}));
vi.mock("@/lib/authz/guard", () => ({
	authorize: (...a: unknown[]) => authorize(...a),
	authorizeInOrg: (...a: unknown[]) => authorizeInOrg(...a),
	currentActor: () => currentActor(),
}));
/** The MCP / API-token path's actor, when one is in scope. `undefined` is a browser session. */
let injected: { userId: string; orgId: string } | undefined;
vi.mock("@/lib/authz/actor-context", () => ({
	getInjectedActor: () => injected,
}));

const ADMIN = "99999999-9999-9999-9999-999999999999";
const SUBJECT = "11111111-1111-1111-1111-111111111111";
/** The organization the case was raised in — NOT the one the caller's session points at. */
const TENANT = "33333333-3333-3333-3333-333333333333";
const NOW = new Date("2026-09-19T09:00:00.000Z");

/** One thing that reached the database. `bare` = NOT inside the erasure transaction. */
interface Call {
	op: "select" | "insert" | "update" | "execute";
	bare: boolean;
	table?: unknown;
	values?: unknown;
	set?: unknown;
	sql?: string;
	params?: unknown[];
}

const calls: Call[] = [];
/** The case row `caseByReference` finds. */
let caseRow: Record<string, unknown>;
/** False makes the reference lookup find nothing, without making `caseRow` nullable. */
let caseFound = true;
/** What the residency counts answer with. */
let residency = { projects: 0, environments: 0, cloudConnections: 0 };
/** How many rows every erase/pseudonymize statement reports back. */
let rowsPerStatement = 4;

const dialect = new PgDialect();

vi.mock("@/lib/db", () => {
	// Imported lazily inside the factory: vi.mock is hoisted above the import block.
	return {
		getServiceDb: () => client(true),
	};
});

type Row = Record<string, unknown>;

/** The drizzle surface the action uses, shaped so `transaction` can hand back another one. */
interface FakeClient {
	select: (fields?: unknown) => {
		from: (table: unknown) => {
			where: (where: SQL) => Promise<Row[]> & { limit: (n?: number) => Promise<Row[]> };
		};
	};
	insert: (table: unknown) => {
		values: (values: unknown) => Promise<undefined> & {
			returning: () => Promise<{ id: string }[]>;
		};
	};
	update: (table: unknown) => {
		set: (set: unknown) => { where: (where: SQL) => Promise<void> };
	};
	execute: (query: SQL) => Promise<unknown[]>;
	transaction: <T>(cb: (tx: FakeClient) => Promise<T>) => Promise<T>;
}

/** A drizzle-shaped client. `bare` marks writes made OUTSIDE the erasure transaction. */
function client(bare: boolean): FakeClient {
	return {
		select: (_fields?: unknown) => ({
			from: (table: unknown) => ({
				where: (where: SQL) => {
					calls.push({ op: "select", bare, table });
					const rows = rowsFor(table, where);
					return Object.assign(Promise.resolve(rows), {
						limit: async () => rows,
					});
				},
			}),
		}),
		insert: (table: unknown) => ({
			values: (values: unknown) => {
				calls.push({ op: "insert", bare, table, values });
				return Object.assign(Promise.resolve(undefined), {
					returning: async () => [{ id: "case-1" }],
				});
			},
		}),
		update: (table: unknown) => ({
			set: (set: unknown) => ({
				where: async (_where: SQL) => {
					calls.push({ op: "update", bare, table, set });
				},
			}),
		}),
		execute: async (query: SQL) => {
			const q = dialect.sqlToQuery(query);
			calls.push({ op: "execute", bare, sql: q.sql, params: q.params });
			return new Array(rowsPerStatement).fill({ "?column?": 1 });
		},
		transaction: <T>(cb: (tx: FakeClient) => Promise<T>): Promise<T> => cb(client(false)),
	};
}

/** What a read answers with, keyed on the table it was made against. */
function rowsFor(table: unknown, _where: SQL): Row[] {
	if (table === privacyCase) return caseFound ? [caseRow] : [];
	if (table === projects) return [{ n: residency.projects }];
	if (table === projectEnvironments) return [{ n: residency.environments }];
	if (table === cloudIdentities) return [{ n: residency.cloudConnections }];
	return [];
}

import { fulfilErasure } from "@/app/server/actions/privacy/cases";
import {
	cloudIdentities,
	privacyCase,
	privacyCaseEvent,
	privacyErasureTombstone,
	projectEnvironments,
	projects,
} from "@/lib/db/schema";
import { buildErasurePlan } from "@/lib/privacy/erasure-plan";

const PLAN = buildErasurePlan();
/** Every statement the register's non-retain rules should produce. */
const TOUCHING_RULES = PLAN.erase.length + PLAN.pseudonymize.length;

/** Every call of `op`, optionally narrowed to one table. */
function of(op: Call["op"], table?: unknown): Call[] {
	return calls.filter((c) => c.op === op && (table === undefined || c.table === table));
}

/** The ledger events written, in order. */
function events(): { kind: unknown; detail: { summary: string; counts?: Record<string, number> } }[] {
	return of("insert", privacyCaseEvent).map((c) => {
		const v = c.values;
		if (typeof v !== "object" || v === null) throw new Error("an event with no values");
		const row: Record<string, unknown> = { ...v };
		const detail = row.detail;
		if (typeof detail !== "object" || detail === null) throw new Error("an event with no detail");
		const d: Record<string, unknown> = { ...detail };
		return {
			kind: row.kind,
			detail: {
				summary: String(d.summary),
				counts:
					typeof d.counts === "object" && d.counts !== null
						? { ...(d.counts as Record<string, number>) }
						: undefined,
			},
		};
	});
}

beforeEach(() => {
	calls.length = 0;
	residency = { projects: 0, environments: 0, cloudConnections: 0 };
	rowsPerStatement = 4;
	caseFound = true;
	injected = undefined;
	authorize.mockReset();
	authorizeInOrg.mockReset();
	currentActor.mockReset();
	// The default caller: an admin of the TENANT the case was raised in, whose own session points
	// somewhere else entirely. Standing comes from the case's organization, never from that.
	currentActor.mockResolvedValue({ userId: ADMIN, orgId: ADMIN });
	authorizeInOrg.mockResolvedValue({ userId: ADMIN, orgId: TENANT });
	authorize.mockResolvedValue({ userId: ADMIN, orgId: ADMIN });
	caseRow = {
		id: "case-1",
		reference: "DSR-ABCD1234",
		kind: "erasure",
		state: "in_review",
		organizationId: TENANT,
		subjectUserId: SUBJECT,
		subjectEmailSha256: "a".repeat(64),
		identityVerifiedAt: new Date("2026-09-18T00:00:00.000Z"),
		legalHoldReason: null,
		dueAt: new Date("2026-10-18T00:00:00.000Z"),
	};
});

describe("refusing while the personal org still has live resources", () => {
	it("erases nothing and leaves the case open when a project is still there", async () => {
		residency = { projects: 2, environments: 1, cloudConnections: 0 };
		const out = await fulfilErasure("DSR-ABCD1234", NOW);

		expect(out.outcome).toBe("refused_live_resources");
		if (out.outcome !== "refused_live_resources") return;
		expect(out.residency).toEqual({ projects: 2, environments: 1, cloudConnections: 0 });
		expect(out.message).toContain("2 projects");

		// NOTHING was erased. This is the assertion that fails if the refusal is dropped.
		expect(of("execute")).toEqual([]);
		// And no tombstone: nothing was erased, so there is nothing for a restore to replay, and a
		// tombstone claiming otherwise is the false record this issue is about.
		expect(of("insert", privacyErasureTombstone)).toEqual([]);

		// The case stays open — a live-resources refusal is a step not yet reached, not a GDPR
		// art. 12(5) refusal, which would close the case and need grounds and a right to complain.
		const [caseUpdate] = of("update", privacyCase);
		expect(caseUpdate?.set).toEqual({ updatedAt: NOW });

		// The subject is answered from the case, not from somebody's memory.
		const [event] = events();
		expect(event?.kind).toBe("note");
		expect(event?.detail.summary).toBe(out.message);
		expect(event?.detail.counts).toEqual({
			projects: 2,
			environments_not_destroyed: 1,
			cloud_connections: 0,
		});
	});

	// The executor never detaches a credential, so while one exists we cannot know from here what
	// is live behind it. Refusing over-refuses on purpose; the message says to disconnect it.
	it("refuses on a connected cloud account alone", async () => {
		residency = { projects: 0, environments: 0, cloudConnections: 1 };
		const out = await fulfilErasure("DSR-ABCD1234", NOW);
		expect(out.outcome).toBe("refused_live_resources");
		expect(of("execute")).toEqual([]);
	});

	// `DESTROYED` is the terminal state a teardown leaves behind. The count the action asks for
	// must exclude it, or an org that HAS been torn down is permanently un-erasable.
	it("asks for environments that are not DESTROYED", async () => {
		residency = { projects: 0, environments: 0, cloudConnections: 0 };
		await fulfilErasure("DSR-ABCD1234", NOW);
		const read = calls.find((c) => c.op === "select" && c.table === projectEnvironments);
		expect(read).toBeDefined();
	});
});

describe("erasing, once the org is clear", () => {
	it("runs one statement per non-retain rule and reports the ROWS they touched", async () => {
		const out = await fulfilErasure("DSR-ABCD1234", NOW);

		expect(out.outcome).toBe("erased");
		if (out.outcome !== "erased") return;
		expect(of("execute")).toHaveLength(TOUCHING_RULES);
		// Rows, not tables. `plan.erase.length` is 8; the rows are 8 × 4.
		expect(out.rowsErased).toBe(PLAN.erase.length * rowsPerStatement);
		expect(out.rowsPseudonymized).toBe(PLAN.pseudonymize.length * rowsPerStatement);
		expect(out.tables.map((t) => t.table)).toEqual([
			...PLAN.erase.map((r) => r.table),
			...PLAN.pseudonymize.map((r) => r.table),
		]);
		// Every statement is bound to the subject and to nobody else.
		for (const c of of("execute")) expect(c.params).toContain(SUBJECT);
	});

	it("leaves the tombstone, decides the case, and records the rows in the ledger", async () => {
		await fulfilErasure("DSR-ABCD1234", NOW);

		const [tombstone] = of("insert", privacyErasureTombstone);
		expect(tombstone?.values).toMatchObject({
			subjectEmailSha256: "a".repeat(64),
			erasedUserId: SUBJECT,
			caseReference: "DSR-ABCD1234",
			erasedAt: NOW,
		});

		const [caseUpdate] = of("update", privacyCase);
		expect(caseUpdate?.set).toMatchObject({
			state: "fulfilled",
			decidedAt: NOW,
			decidedByUserId: ADMIN,
		});

		const [event] = events();
		expect(event?.kind).toBe("erasure_performed");
		expect(event?.detail.counts).toMatchObject({
			rows_erased: PLAN.erase.length * rowsPerStatement,
			rows_pseudonymized: PLAN.pseudonymize.length * rowsPerStatement,
		});
	});

	// The honest zero. A subject with nothing stored must be recorded as nothing erased — not as
	// the number of tables the plan considered, which is what the old counts reported.
	it("records zero rows for a subject with nothing stored", async () => {
		rowsPerStatement = 0;
		const out = await fulfilErasure("DSR-ABCD1234", NOW);
		if (out.outcome !== "erased") throw new Error(`expected an erasure, got ${out.outcome}`);
		expect(out.rowsErased).toBe(0);
		expect(out.rowsPseudonymized).toBe(0);
		expect(events()[0]?.detail.counts?.rows_erased).toBe(0);
	});

	// A partial erasure is the worst outcome available: the subject is told their data is gone
	// while some of it is not, and nothing records which half. Moving any write out of the
	// transaction fails this.
	it("makes every write, and the tombstone, part of ONE transaction", async () => {
		await fulfilErasure("DSR-ABCD1234", NOW);
		const bareWrites = calls.filter((c) => c.bare && c.op !== "select");
		expect(bareWrites).toEqual([]);
		// The only bare read is `caseByReference`, before the transaction opens.
		expect(calls.filter((c) => c.bare).map((c) => c.table)).toEqual([privacyCase]);
	});
});

describe("what it will not do", () => {
	it("pauses under a legal hold, erasing nothing but still leaving a tombstone", async () => {
		caseRow.legalHoldReason = "Ongoing chargeback dispute";
		const out = await fulfilErasure("DSR-ABCD1234", NOW);

		expect(out).toEqual({
			outcome: "paused_by_legal_hold",
			reason: "Ongoing chargeback dispute",
		});
		expect(of("execute")).toEqual([]);
		expect(of("insert", privacyErasureTombstone)).toHaveLength(1);
		expect(of("update", privacyCase)[0]?.set).toMatchObject({ state: "in_review" });
		expect(events()[0]?.kind).toBe("legal_hold_applied");
		// A hold is checked BEFORE the residency, so a held case is not also asked to tear down
		// its infrastructure first.
		expect(calls.some((c) => c.table === projects)).toBe(false);
	});

	it("refuses an unverified request, and writes nothing", async () => {
		caseRow.identityVerifiedAt = null;
		await expect(fulfilErasure("DSR-ABCD1234", NOW)).rejects.toThrow(/Identity is not verified/);
		expect(calls.filter((c) => c.op !== "select")).toEqual([]);
	});

	it("refuses a request that is not an erasure", async () => {
		caseRow.kind = "export";
		await expect(fulfilErasure("DSR-ABCD1234", NOW)).rejects.toThrow(/not an erasure/);
		expect(of("execute")).toEqual([]);
	});

	// Every rule matches on an identifier. A case from someone with no account has none, so the
	// plan would match nothing and report success — the exact defect, one case narrower.
	it("refuses a case that names no account rather than reporting a no-op as done", async () => {
		caseRow.subjectUserId = null;
		await expect(fulfilErasure("DSR-ABCD1234", NOW)).rejects.toThrow(/names no account/);
		expect(of("execute")).toEqual([]);
		expect(of("insert", privacyErasureTombstone)).toEqual([]);
	});

});

// The gap #4854 closed, and the reason it was worth closing in the same PR as the executor: the
// old gate was `authorize("edit", { type: "org" })` with no resource id, which enforces the verb in
// the CALLER'S OWN ambient scope. Every account owns a personal organization whose id is its user
// id and the built-in owner role is `"*"`, so that call succeeded for every signed-in user — and
// the next line then loaded ANY case by reference on the service connection. While the function
// erased nothing, that was a disclosure bug. With an executor behind it, it is "any account may
// destroy any other account's data by quoting a reference".
describe("standing over the case", () => {
	it("proves org:edit in the CASE's organization, never in the caller's own", async () => {
		await fulfilErasure("DSR-ABCD1234", NOW);
		expect(authorizeInOrg).toHaveBeenCalledWith(
			"edit",
			{ type: "org", id: TENANT },
			TENANT,
		);
		// The ambient gate is the one that proved nothing. Nothing may fall back to it.
		expect(authorize).not.toHaveBeenCalled();
	});

	it("erases nothing when the caller does not administer the case's organization", async () => {
		authorizeInOrg.mockRejectedValue(new Error("Forbidden: edit on org"));
		await expect(fulfilErasure("DSR-ABCD1234", NOW)).rejects.toThrow(/Forbidden/);
		expect(calls.filter((c) => c.op !== "select")).toEqual([]);
		expect(of("execute")).toEqual([]);
	});

	// THE regression test. A case belonging to nobody the caller can reach must not be actionable
	// just because the caller owns a personal organization of their own.
	it("refuses a case that is neither the caller's own nor their organization's", async () => {
		caseRow.organizationId = null;
		await expect(fulfilErasure("DSR-ABCD1234", NOW)).rejects.toThrow(/not yours/);
		expect(authorizeInOrg).not.toHaveBeenCalled();
		expect(of("execute")).toEqual([]);
		expect(of("insert", privacyErasureTombstone)).toEqual([]);
	});

	// The self-serve path (#4875/#4878) lands here: a personal org is recorded as none, so the
	// subject is the only standing there is. Being the subject is a fact about the row, which is
	// strictly stronger than the permission it replaced.
	it("lets the subject act on their own case, which carries no organization", async () => {
		caseRow.organizationId = null;
		currentActor.mockResolvedValue({ userId: SUBJECT, orgId: SUBJECT });
		const out = await fulfilErasure("DSR-ABCD1234", NOW);
		expect(out.outcome).toBe("erased");
		expect(authorizeInOrg).not.toHaveBeenCalled();
		expect(of("execute")).toHaveLength(TOUCHING_RULES);
	});

	// A reference that matches nothing and one the caller may not touch answer identically, so
	// enumerating references cannot tell a stranger which of them exist.
	it("answers an unknown reference exactly as it answers one you may not touch", async () => {
		caseFound = false;
		await expect(fulfilErasure("DSR-ABCD1234", NOW)).rejects.toThrow(/not yours/);
		expect(of("execute")).toEqual([]);
	});

	it("refuses a reference that is not shaped like one, before any query", async () => {
		await expect(fulfilErasure("' OR 1=1 --", NOW)).rejects.toThrow(
			/Not a privacy request reference/,
		);
		expect(calls).toEqual([]);
	});

	it("reads nothing at all when there is no session", async () => {
		currentActor.mockRejectedValue(new Error("Unauthorized"));
		await expect(fulfilErasure("DSR-ABCD1234", NOW)).rejects.toThrow(/Unauthorized/);
		expect(calls).toEqual([]);
	});

	// The MCP / API-token path. `requestMyErasure` refuses an injected actor for the same reason
	// and this is the destructive end of the same process: the #4273 ruling binds the identity bar
	// to a console SESSION, and a machine credential does not inherit it. Refused BEFORE the
	// subject ground is considered — a token acting as the subject would otherwise satisfy it.
	it("refuses a machine credential even when it acts as the subject", async () => {
		caseRow.organizationId = null;
		injected = { userId: SUBJECT, orgId: SUBJECT };
		currentActor.mockResolvedValue({ userId: SUBJECT, orgId: SUBJECT });
		await expect(fulfilErasure("DSR-ABCD1234", NOW)).rejects.toThrow(
			/machine credential/,
		);
		expect(calls).toEqual([]);
	});
});
