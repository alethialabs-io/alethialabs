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
/** A team organization the subject is a member of. Its resources are not the personal org's. */
const TEAM = "55555555-5555-5555-5555-555555555555";
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
/**
 * What the residency counts answer with, PER ORGANIZATION.
 *
 * Keyed by org id because the count is no longer about one org: since #4854's security review
 * `findLiveResidency` asks about the personal org AND every team org the subject is the only
 * active owner of, and a fake that could answer for only one of them could not tell them apart.
 */
let residency: Record<
	string,
	{ projects: number; environments: number; cloudConnections: number }
> = {};
/** The subject's active `member` rows. Empty means they own no team organization. */
let memberRows: {
	organizationId: string;
	userId: string;
	role: string;
	status: string;
}[] = [];
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
			where: (where: SQL) => Promise<Row[]> & {
				limit: (n?: number) => Promise<Row[]>;
				groupBy: (...by: unknown[]) => Promise<Row[]>;
			};
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
						// The residency counts are GROUPED by org id since the security review; a
						// fake with no `groupBy` fails on the chain rather than on the assertion.
						groupBy: async () => rows,
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

/**
 * The values bound into a WHERE clause.
 *
 * The fake HONOURS the org predicate rather than ignoring it, and that is the difference between
 * a residency test and a test of its own fixture: with the predicate ignored, an org that should
 * have been excluded from the count still contributes to it, and "this org does not block" passes
 * for every implementation including one that never excluded anything.
 */
function paramsOf(where: SQL): unknown[] {
	return dialect.sqlToQuery(where).params;
}

/** One grouped row per org IN SCOPE that has any — which is what `group by` returns. */
function grouped(
	where: SQL,
	pick: (c: { projects: number; environments: number; cloudConnections: number }) => number,
): Row[] {
	const scope = paramsOf(where);
	return Object.entries(residency)
		.filter(([orgId]) => scope.includes(orgId))
		.map(([orgId, counts]) => ({ orgId, n: pick(counts) }))
		.filter((r) => r.n > 0);
}

/** What a read answers with, keyed on the table it was made against. */
function rowsFor(table: unknown, where: SQL): Row[] {
	if (table === privacyCase) return caseFound ? [caseRow] : [];
	if (table === member) {
		// Both membership reads filter on `status = 'active'`; the first also names the subject,
		// the second the organizations, so one predicate serves both. The rows come back under the
		// SELECT's aliases (`orgId`), not the column names — a fixture that kept the column names
		// would hand the caller `undefined` org ids and every org would silently drop out.
		const scope = paramsOf(where);
		return memberRows
			.filter(
				(m) =>
					m.status === "active" &&
					(scope.includes(m.userId) || scope.includes(m.organizationId)),
			)
			.map((m) => ({ orgId: m.organizationId, userId: m.userId, role: m.role }));
	}
	if (table === projects) return grouped(where, (c) => c.projects);
	if (table === projectEnvironments) return grouped(where, (c) => c.environments);
	if (table === cloudIdentities) return grouped(where, (c) => c.cloudConnections);
	return [];
}

import { fulfilErasure } from "@/app/server/actions/privacy/cases";
import {
	cloudIdentities,
	member,
	privacyCase,
	privacyCaseEvent,
	privacyErasureTombstone,
	projectEnvironments,
	projects,
} from "@/lib/db/schema";
import { ForbiddenError } from "@/lib/authz/types";
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
	residency = {};
	memberRows = [];
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

describe("refusing while an org only the subject can reach has live resources", () => {
	it("erases nothing and leaves the case open when a project is still there", async () => {
		residency = { [SUBJECT]: { projects: 2, environments: 1, cloudConnections: 0 } };
		const out = await fulfilErasure("DSR-ABCD1234", NOW);

		expect(out.outcome).toBe("refused_live_resources");
		if (out.outcome !== "refused_live_resources") return;
		expect(out.residency).toEqual({
			projects: 2,
			environments: 1,
			cloudConnections: 0,
			soleOwnedOrganizations: 0,
		});
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
			sole_owned_organizations: 0,
		});
	});

	// The executor never detaches a credential, so while one exists we cannot know from here what
	// is live behind it. Refusing over-refuses on purpose; the message says to disconnect it.
	it("refuses on a connected cloud account alone", async () => {
		residency = { [SUBJECT]: { projects: 0, environments: 0, cloudConnections: 1 } };
		const out = await fulfilErasure("DSR-ABCD1234", NOW);
		expect(out.outcome).toBe("refused_live_resources");
		expect(of("execute")).toEqual([]);
	});

	// THE TEAM ORG THE SUBJECT ALONE OWNS. The erasure deletes every session and rewrites the
	// address, so the account can never sign in again; `member` carries no rule, so the subject
	// stays that org's only owner. Counting only the personal org produced exactly the outcome the
	// count exists to prevent — infrastructure running with nobody able to reach or bill it.
	it("refuses over an organization the subject is the only active owner of", async () => {
		memberRows = [
			{ organizationId: TEAM, userId: SUBJECT, role: "owner", status: "active" },
			{ organizationId: TEAM, userId: ADMIN, role: "admin", status: "active" },
		];
		residency = { [TEAM]: { projects: 3, environments: 0, cloudConnections: 0 } };
		const out = await fulfilErasure("DSR-ABCD1234", NOW);

		expect(out.outcome).toBe("refused_live_resources");
		if (out.outcome !== "refused_live_resources") return;
		expect(out.residency.projects).toBe(3);
		expect(out.residency.soleOwnedOrganizations).toBe(1);
		// The instruction has to be the one that clears THIS: destroying projects is not enough if
		// the organization should outlive the person.
		expect(out.message).toMatch(/only owner of/);
		expect(out.message).toMatch(/make somebody else an owner/);
		expect(of("execute")).toEqual([]);
	});

	// A second active owner can tear it down, so that org is not stranded and does not block.
	it("does not count an organization that has another active owner", async () => {
		memberRows = [
			{ organizationId: TEAM, userId: SUBJECT, role: "owner", status: "active" },
			{ organizationId: TEAM, userId: ADMIN, role: "owner", status: "active" },
		];
		residency = { [TEAM]: { projects: 3, environments: 0, cloudConnections: 0 } };
		const out = await fulfilErasure("DSR-ABCD1234", NOW);
		expect(out.outcome).toBe("erased");
	});

	// `member.role` is TEXT and the org plugin stores a comma-joined list for a multi-role invite,
	// so `role = 'owner'` misses a real owner — and missing one is the under-refusal, not the
	// over-refusal. Asserted in both directions in one test: the subject's own multi-role row must
	// count as ownership, and so must the OTHER owner's.
	it("reads a comma-joined role as the ownership it grants", async () => {
		memberRows = [
			{ organizationId: TEAM, userId: SUBJECT, role: "owner,admin", status: "active" },
		];
		residency = { [TEAM]: { projects: 1, environments: 0, cloudConnections: 0 } };
		expect((await fulfilErasure("DSR-ABCD1234", NOW)).outcome).toBe(
			"refused_live_resources",
		);

		calls.length = 0;
		memberRows = [
			{ organizationId: TEAM, userId: SUBJECT, role: "owner", status: "active" },
			{ organizationId: TEAM, userId: ADMIN, role: "admin,owner", status: "active" },
		];
		expect((await fulfilErasure("DSR-ABCD1234", NOW)).outcome).toBe("erased");
	});

	// A suspended member holds the role and not the access, so they cannot tear anything down
	// either — the org is still stranded.
	it("treats a suspended second owner as no second owner", async () => {
		memberRows = [
			{ organizationId: TEAM, userId: SUBJECT, role: "owner", status: "active" },
			{ organizationId: TEAM, userId: ADMIN, role: "owner", status: "suspended" },
		];
		residency = { [TEAM]: { projects: 1, environments: 0, cloudConnections: 0 } };
		expect((await fulfilErasure("DSR-ABCD1234", NOW)).outcome).toBe(
			"refused_live_resources",
		);
	});

	// The bound, stated as a test because it is a DECISION and not an oversight: an empty
	// sole-owned org is orphaned, which is a membership question nobody has ruled on. The ruling
	// this step implements is about infrastructure left running, and there is none.
	it("does not block on a sole-owned organization that holds nothing", async () => {
		memberRows = [
			{ organizationId: TEAM, userId: SUBJECT, role: "owner", status: "active" },
		];
		residency = {};
		expect((await fulfilErasure("DSR-ABCD1234", NOW)).outcome).toBe("erased");
	});

	// `DESTROYED` is the terminal state a teardown leaves behind. The count the action asks for
	// must exclude it, or an org that HAS been torn down is permanently un-erasable.
	it("asks for environments that are not DESTROYED", async () => {
		residency = {};
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
		await expect(fulfilErasure("DSR-ABCD1234", NOW)).rejects.toThrow(/not yours to decide/);
		expect(authorizeInOrg).not.toHaveBeenCalled();
		expect(of("execute")).toEqual([]);
		expect(of("insert", privacyErasureTombstone)).toEqual([]);
	});

	// SEPARATION OF DUTY, and the reason this endpoint needs it. `requestMyErasure` hands the
	// browser a reference to a case it has already marked identity-verified, and this module is
	// `"use server"` — so admitting the subject would make an irreversible erasure reachable in ONE
	// unconfirmed POST, with no confirmation dialog, no `destructive-actions.yaml` row and no e2e
	// coverage, while the account dialog promises a person reviews it. The subject may READ their
	// own case (`privacyCaseHistory`); they are not the second party to their own erasure.
	it("refuses the SUBJECT on their own case — an erasure needs a second party", async () => {
		caseRow.organizationId = null;
		currentActor.mockResolvedValue({ userId: SUBJECT, orgId: SUBJECT });
		await expect(fulfilErasure("DSR-ABCD1234", NOW)).rejects.toThrow(/not yours to decide/);
		expect(of("execute")).toEqual([]);
		expect(of("insert", privacyErasureTombstone)).toEqual([]);
	});

	// …and not even when the case WAS raised in an org, if that is the only thing the caller has.
	it("refuses the subject even on a case their own organization raised", async () => {
		currentActor.mockResolvedValue({ userId: SUBJECT, orgId: TENANT });
		authorizeInOrg.mockRejectedValue(
			new ForbiddenError("edit", { type: "org", id: TENANT }, "not scoped"),
		);
		await expect(fulfilErasure("DSR-ABCD1234", NOW)).rejects.toThrow(/not yours to decide/);
		expect(of("execute")).toEqual([]);
	});

	// The guard's own refusal says "not scoped to organization <id>" and CARRIES THE CASE'S
	// ORGANIZATION ID — a fact about a case the caller has just been told it may not see. It is
	// converted into this module's one message so the refusals cannot be told apart by their text.
	it("never lets the guard's refusal name the case's organization", async () => {
		authorizeInOrg.mockRejectedValue(
			new ForbiddenError("edit", { type: "org", id: TENANT }, "not scoped"),
		);
		const err = await fulfilErasure("DSR-ABCD1234", NOW).catch((e: unknown) => e);
		expect(String(err)).not.toContain(TENANT);
		expect(String(err)).toMatch(/not yours to decide/);
	});

	// …and ONLY a ForbiddenError is converted. A database failure inside the guard must keep
	// propagating as an error: reporting an outage as a denial is how a broken lookup starts
	// answering "no" for everyone.
	it("lets a non-authorization failure inside the guard propagate", async () => {
		authorizeInOrg.mockRejectedValue(new Error("connection terminated"));
		await expect(fulfilErasure("DSR-ABCD1234", NOW)).rejects.toThrow(
			/connection terminated/,
		);
	});

	// A reference that matches nothing and one the caller may not touch answer identically, so
	// enumerating references cannot tell a stranger which of them exist.
	it("answers an unknown reference exactly as it answers one you may not touch", async () => {
		caseFound = false;
		await expect(fulfilErasure("DSR-ABCD1234", NOW)).rejects.toThrow(/not yours to decide/);
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
	// to a console SESSION, and a machine credential does not inherit it. Refused BEFORE anything
	// is read, so a token holding a legitimate org grant never reaches the case at all.
	it("refuses a machine credential, before it reads anything", async () => {
		injected = { userId: ADMIN, orgId: TENANT };
		await expect(fulfilErasure("DSR-ABCD1234", NOW)).rejects.toThrow(
			/machine credential/,
		);
		expect(calls).toEqual([]);
	});
});
