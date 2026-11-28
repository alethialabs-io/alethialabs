// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// The plan metadata backfill (scripts/backfill-plan-metadata.ts, #7949). Its reduction is a port of
// the runner's (apps/runner/internal/agent/plan_metadata.go), so both are tested against ONE fixture:
// apps/runner/internal/agent/testdata/plan-metadata/cases.json, which the Go test
// TestPlanMetadataFixture_RunnerRecordsWant runs through the runner's plan path. The database is an
// in-memory stand-in for the script's BackfillDb seam; the pass itself runs for real.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { signSnapshot, verifySnapshot } from "@/lib/runners/snapshot-sig";
import {
	type AuditDbRow,
	auditRowPlan,
	type BackfillDb,
	type BackfillTx,
	backfillAuditRows,
	backfillPlanRows,
	formatCounts,
	parseArgs,
	parseExact,
	planRowPlan,
	reducePlanResult,
} from "@/scripts/backfill-plan-metadata";

/** One fixture case: an earlier runner's plan_result and the current runner's for the same plan. */
interface FixtureCase {
	name: string;
	stored: { [key: string]: unknown };
	want: { [key: string]: unknown };
}

/** True for a JSON object. */
function isObject(value: unknown): value is { [key: string]: unknown } {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reads the shared fixture, refusing one that does not have the expected shape. */
function loadCases(): FixtureCase[] {
	const path = fileURLToPath(
		new URL("../../../runner/internal/agent/testdata/plan-metadata/cases.json", import.meta.url),
	);
	const doc: unknown = JSON.parse(readFileSync(path, "utf8"));
	if (!isObject(doc) || !Array.isArray(doc.cases)) throw new Error("fixture has no cases list");
	return doc.cases.map((c: unknown) => {
		if (!isObject(c) || typeof c.name !== "string" || !isObject(c.stored) || !isObject(c.want)) {
			throw new Error("fixture case has the wrong shape");
		}
		return { name: c.name, stored: c.stored, want: c.want };
	});
}

const cases = loadCases();

/** The fixture case with this name. */
function fixture(name: string): FixtureCase {
	const found = cases.find((c) => c.name === name);
	if (!found) throw new Error(`no fixture case named ${name}`);
	return found;
}

const APPLY_CASE = fixture("apply plan with masked, unknown and prior values");
const NO_CHANGE_CASE = fixture("no-change plan document keeps only its format_version");

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("reducePlanResult matches the runner on the shared fixture", () => {
	it("has cases to check", () => {
		expect(cases.length).toBeGreaterThanOrEqual(5);
	});

	for (const c of cases) {
		it(`${c.name}: stored → current shape`, () => {
			expect(reducePlanResult(c.stored)).toStrictEqual(c.want);
		});
		it(`${c.name}: the current shape is a fixed point`, () => {
			expect(reducePlanResult(c.want)).toStrictEqual(c.want);
		});
	}

	it("keeps none of the values the fixture marks as not kept", () => {
		for (const c of cases) {
			expect(JSON.stringify(reducePlanResult(c.stored))).not.toContain("value-not-kept");
		}
	});
});

describe("planRowPlan", () => {
	it("rewrites an earlier row to the current shape, and leaves the result alone", () => {
		const first = planRowPlan(JSON.stringify(APPLY_CASE.stored));
		if (first.kind !== "change") throw new Error(`expected a change, got ${first.kind}`);
		expect(JSON.parse(first.text)).toStrictEqual(APPLY_CASE.want);
		expect(planRowPlan(first.text)).toStrictEqual({ kind: "unchanged" });
	});

	it("reduces a no-change plan document to its format_version", () => {
		const plan = planRowPlan(JSON.stringify(NO_CHANGE_CASE.stored));
		expect(plan).toStrictEqual({ kind: "change", text: JSON.stringify({ format_version: "1.2" }) });
	});

	it("counts a row already current regardless of key order or spacing as unchanged", () => {
		const text = '{ "format_version" : "1.2" }';
		expect(planRowPlan(text)).toStrictEqual({ kind: "unchanged" });
	});

	it("leaves a row it cannot read exactly as it is", () => {
		expect(planRowPlan("not json")).toStrictEqual({ kind: "unreadable" });
		expect(planRowPlan('"a string plan"')).toStrictEqual({ kind: "unreadable" });
		expect(planRowPlan("[1,2]")).toStrictEqual({ kind: "unreadable" });
		const big = '{"resource_changes":[{"address":"a","change":{"actions":["create"],"after":{"n":12345678901234567890},"before":{}}}]}';
		expect(planRowPlan(big)).toStrictEqual({ kind: "unreadable" });
	});
});

describe("parseExact", () => {
	it("accepts numbers a double carries exactly", () => {
		expect(parseExact('{"a":5432,"b":-1.5,"c":1e3,"d":0.000001,"e":10000000000000000000,"f":0}')).toStrictEqual({
			ok: true,
			value: { a: 5432, b: -1.5, c: 1000, d: 0.000001, e: 1e19, f: 0 },
		});
	});

	it("refuses a number it would round, overflow or flush to zero", () => {
		expect(parseExact('{"a":9007199254740993}')).toStrictEqual({ ok: false });
		expect(parseExact('{"a":0.12345678901234567}')).toStrictEqual({ ok: false });
		expect(parseExact('{"a":1e400}')).toStrictEqual({ ok: false });
		expect(parseExact('{"a":1e-400}')).toStrictEqual({ ok: false });
	});
});

/** An AUDIT row of kind `plan` whose input is `input`. */
function auditRow(input: string, status = "SUCCESS", sig: string | null = null): AuditDbRow {
	return {
		id: "00000000-0000-0000-0000-000000000001",
		status,
		config_snapshot: JSON.stringify({ audit_kind: "plan", audit_input: input }),
		config_snapshot_sig: sig,
	};
}

/** The audit_input of a snapshot written by a change. */
function auditInputOf(snapshotText: string): unknown {
	const snapshot: unknown = JSON.parse(snapshotText);
	if (!isObject(snapshot) || typeof snapshot.audit_input !== "string") throw new Error("no audit_input");
	expect(snapshot.audit_kind).toBe("plan");
	return JSON.parse(snapshot.audit_input);
}

describe("auditRowPlan", () => {
	it("rewrites a settled, unsigned audit input to the current shape, once", () => {
		const plan = auditRowPlan(auditRow(JSON.stringify(APPLY_CASE.stored)), false);
		if (plan.kind !== "change") throw new Error(`expected a change, got ${plan.kind}`);
		expect(auditInputOf(plan.text)).toStrictEqual(APPLY_CASE.want);
		expect(plan.sig).toBeNull();
		expect(auditRowPlan({ ...auditRow(""), config_snapshot: plan.text }, false)).toStrictEqual({ kind: "unchanged" });
	});

	it("reduces a pasted full plan document, dropping everything but its resource changes", () => {
		const pasted = { format_version: "1.2", variables: { v: { value: "value-not-kept-var" } }, ...APPLY_CASE.stored };
		const plan = auditRowPlan(auditRow(JSON.stringify(pasted, null, 2)), false);
		if (plan.kind !== "change") throw new Error(`expected a change, got ${plan.kind}`);
		expect(auditInputOf(plan.text)).toStrictEqual(APPLY_CASE.want);
		expect(plan.text).not.toContain("value-not-kept");
	});

	it("reduces a no-change audit input to its format_version", () => {
		const plan = auditRowPlan(auditRow(JSON.stringify(NO_CHANGE_CASE.stored)), false);
		if (plan.kind !== "change") throw new Error(`expected a change, got ${plan.kind}`);
		expect(auditInputOf(plan.text)).toStrictEqual({ format_version: "1.2" });
	});

	it("re-signs a signed row under the configured key, and the claim check accepts it", () => {
		vi.stubEnv("ALETHIA_SNAPSHOT_HMAC_KEY", "test-hmac-key");
		const input = JSON.stringify(APPLY_CASE.stored);
		const oldSig = signSnapshot({ audit_kind: "plan", audit_input: input });
		const plan = auditRowPlan(auditRow(input, "FAILED", oldSig), true);
		if (plan.kind !== "change") throw new Error(`expected a change, got ${plan.kind}`);
		const next: unknown = JSON.parse(plan.text);
		expect(plan.sig).not.toBeNull();
		expect(plan.sig).not.toBe(oldSig);
		expect(verifySnapshot(next, plan.sig)).toBe(true);
	});

	it("leaves a signed row alone when the key is absent or does not verify its signature", () => {
		vi.stubEnv("ALETHIA_SNAPSHOT_HMAC_KEY", "test-hmac-key");
		const input = JSON.stringify(APPLY_CASE.stored);
		const oldSig = signSnapshot({ audit_kind: "plan", audit_input: input });
		expect(auditRowPlan(auditRow(input, "SUCCESS", oldSig), false)).toStrictEqual({ kind: "unsignable" });
		expect(auditRowPlan(auditRow(input, "SUCCESS", "00".repeat(32)), true)).toStrictEqual({ kind: "unsignable" });
	});

	it("leaves a still-claimable audit for a later run", () => {
		for (const status of ["QUEUED", "CLAIMED", "PROCESSING"]) {
			expect(auditRowPlan(auditRow(JSON.stringify(APPLY_CASE.stored), status), false)).toStrictEqual({
				kind: "pending",
			});
		}
	});

	it("leaves an input that is not a recognisable plan exactly as it is", () => {
		expect(auditRowPlan(auditRow("not json"), false)).toStrictEqual({ kind: "unreadable" });
		expect(auditRowPlan(auditRow('{"kind":"something else"}'), false)).toStrictEqual({ kind: "unreadable" });
		expect(auditRowPlan({ ...auditRow(""), config_snapshot: '{"audit_kind":"plan"}' }, false)).toStrictEqual({
			kind: "unreadable",
		});
	});
});

// ── The pass, over an in-memory database ───────────────────────────────────────────────────────────

/** The stand-in jobs table: PLAN rows' plan_result text and AUDIT rows, by id. */
interface FakeTables {
	plans: Map<string, string>;
	audits: Map<string, AuditDbRow>;
	/** Ids whose next write loses the compare-and-set, as if the row changed first. */
	racing: Set<string>;
	writes: number;
	transactions: number;
}

/** A uuid-shaped id that sorts by n. */
function id(n: number): string {
	return `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
}

/** A BackfillDb over FakeTables, paging and comparing-and-setting as the real queries do. */
function fakeDb(t: FakeTables): BackfillDb {
	const tx: BackfillTx = {
		selectPlanRows: async (cursor, limit) =>
			[...t.plans.entries()]
				.filter(([k]) => k > cursor)
				.sort(([a], [b]) => (a < b ? -1 : 1))
				.slice(0, limit)
				.map(([k, plan_result]) => ({ id: k, plan_result })),
		updatePlanResult: async (rowId, expected, text) => {
			if (t.racing.delete(rowId) || t.plans.get(rowId) !== expected) return false;
			t.plans.set(rowId, text);
			t.writes++;
			return true;
		},
		selectAuditRows: async (cursor, limit) =>
			[...t.audits.values()]
				.filter((r) => r.id > cursor)
				.sort((a, b) => (a.id < b.id ? -1 : 1))
				.slice(0, limit)
				.map((r) => ({ ...r })),
		updateAuditSnapshot: async (row, text, sig) => {
			const now = t.audits.get(row.id);
			if (t.racing.delete(row.id) || !now || now.config_snapshot !== row.config_snapshot) return false;
			t.audits.set(row.id, { ...now, config_snapshot: text, config_snapshot_sig: sig });
			t.writes++;
			return true;
		},
	};
	return {
		transaction: async (fn) => {
			t.transactions++;
			return fn(tx);
		},
	};
}

/** Tables holding every fixture case as an earlier PLAN row, plus already-current and unreadable rows. */
function seededTables(): FakeTables {
	const plans = new Map<string, string>();
	cases.forEach((c, i) => plans.set(id(i + 1), JSON.stringify(c.stored)));
	plans.set(id(100), JSON.stringify(APPLY_CASE.want));
	plans.set(id(101), '"not an object"');
	const audits = new Map<string, AuditDbRow>();
	audits.set(id(1), { ...auditRow(JSON.stringify(APPLY_CASE.stored)), id: id(1) });
	audits.set(id(2), { ...auditRow(JSON.stringify(APPLY_CASE.stored), "QUEUED"), id: id(2) });
	audits.set(id(3), { ...auditRow(JSON.stringify(NO_CHANGE_CASE.want)), id: id(3) });
	return { plans, audits, racing: new Set(), writes: 0, transactions: 0 };
}

describe("the backfill pass", () => {
	const apply = { apply: true, batch: 2, keyConfigured: false };

	it("a dry run counts what would change and writes nothing", async () => {
		const t = seededTables();
		const before = new Map(t.plans);
		const plans = await backfillPlanRows(fakeDb(t), { ...apply, apply: false });
		const audits = await backfillAuditRows(fakeDb(t), { ...apply, apply: false });
		const changing = cases.filter((c) => JSON.stringify(c.stored) !== JSON.stringify(c.want)).length;
		expect(plans).toStrictEqual({
			matched: cases.length + 2,
			changed: changing,
			unchanged: cases.length - changing + 1,
			unreadable: 1,
			pending: 0,
			unsignable: 0,
			raced: 0,
		});
		expect(audits).toMatchObject({ matched: 3, changed: 1, unchanged: 1, pending: 1 });
		expect(t.writes).toBe(0);
		expect(t.plans).toStrictEqual(before);
	});

	it("--apply brings every row to the current shape in batches, and a second run changes 0 rows", async () => {
		const t = seededTables();
		const first = await backfillPlanRows(fakeDb(t), apply);
		expect(first.changed).toBeGreaterThan(0);
		expect(t.transactions).toBe(Math.floor((cases.length + 2) / apply.batch) + 1);
		cases.forEach((c, i) => {
			expect(JSON.parse(t.plans.get(id(i + 1)) ?? "null")).toStrictEqual(c.want);
		});
		const audits = await backfillAuditRows(fakeDb(t), apply);
		expect(audits.changed).toBe(1);
		const audited = t.audits.get(id(1));
		expect(auditInputOf(audited?.config_snapshot ?? "{}")).toStrictEqual(APPLY_CASE.want);
		expect(t.audits.get(id(2))?.config_snapshot).toBe(seededTables().audits.get(id(2))?.config_snapshot);

		const writes = t.writes;
		expect((await backfillPlanRows(fakeDb(t), apply)).changed).toBe(0);
		expect((await backfillAuditRows(fakeDb(t), apply)).changed).toBe(0);
		expect(t.writes).toBe(writes);
	});

	it("a row that changed between the read and the write is counted as raced and settled next run", async () => {
		const t = seededTables();
		t.racing.add(id(1));
		expect((await backfillPlanRows(fakeDb(t), apply)).raced).toBe(1);
		expect(t.plans.get(id(1))).toBe(JSON.stringify(cases[0]?.stored));
		const second = await backfillPlanRows(fakeDb(t), apply);
		expect(second).toMatchObject({ changed: 1, raced: 0 });
	});

	it("prints counts only", () => {
		const line = formatCounts("PLAN plan_result", { matched: 3, changed: 2, unchanged: 1, unreadable: 0, pending: 0, unsignable: 0, raced: 0 }, false);
		expect(line).toBe(
			"  PLAN plan_result: matched 3, would change 2, unchanged 1, unreadable 0, pending 0, unsignable 0, raced 0",
		);
	});
});

describe("parseArgs", () => {
	it("is a dry run unless --apply is given, and refuses anything else", () => {
		expect(parseArgs([])).toStrictEqual({ apply: false });
		expect(parseArgs(["--dry-run"])).toStrictEqual({ apply: false });
		expect(parseArgs(["--", "--apply"])).toStrictEqual({ apply: true });
		expect(parseArgs(["--aply"])).toMatchObject({ error: expect.stringContaining("--aply") });
	});
});

describe("the postgres writes", () => {
	// postgres-js types a parameter from its cast: `${text}::jsonb` JSON-encodes the string and stores a
	// JSON string holding the document. The first production run did exactly that (#7962).
	const source = readFileSync(
		fileURLToPath(new URL("../../scripts/backfill-plan-metadata.ts", import.meta.url)),
		"utf8",
	);

	it("never binds a value straight to jsonb", () => {
		expect(source).not.toMatch(/\$\{[^}]+\}::jsonb/);
	});

	it("binds both written values as text, then casts", () => {
		expect(source).toMatch(/jsonb_set\(execution_metadata, '\{plan_result\}', \$\{text\}::text::jsonb\)/);
		expect(source).toMatch(/set config_snapshot = \$\{text\}::text::jsonb,/);
	});
});
