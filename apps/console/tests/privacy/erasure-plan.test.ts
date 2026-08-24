// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The erasure plan decides what a deletion request destroys, what it unlinks, and what it must keep
// (#2373). Getting it wrong in either direction is serious and silent: too much takes another
// party's records with it, too little keeps what we told the subject was gone.
//
// These assert the register's invariants and the two behaviours a reviewer would actually check —
// that a retained table names a legal basis, and that a legal hold pauses rather than refuses.

import { describe, expect, it } from "vitest";
import {
	ERASURE_RULES,
	VENDOR_ERASURES,
	buildErasurePlan,
	planToScope,
} from "@/lib/privacy/erasure-plan";

const AT = new Date("2026-08-24T12:00:00.000Z");

describe("the erasure register", () => {
	it("gives every rule a table, a subject column and a reason", () => {
		expect(ERASURE_RULES.length).toBeGreaterThan(5);
		for (const r of ERASURE_RULES) {
			expect(r.table).toBeTruthy();
			expect(r.subjectColumn).toBeTruthy();
			// A rule nobody wrote a reason for is a rule nobody can review — and this register IS the
			// reviewable artefact.
			expect(r.reason.length).toBeGreaterThan(40);
		}
	});

	it("lists each table once", () => {
		const seen = new Set<string>();
		for (const r of ERASURE_RULES) {
			expect(seen.has(r.table)).toBe(false);
			seen.add(r.table);
		}
	});

	// A pseudonymize rule that names no columns overwrites nothing — it would report the row as
	// handled while leaving the identifier in place, which is the worst of both outcomes.
	it("makes every pseudonymize rule name the columns it overwrites", () => {
		for (const r of ERASURE_RULES.filter((x) => x.disposition === "pseudonymize")) {
			expect(r.pseudonymize).toBeTruthy();
			expect(r.pseudonymize?.length ?? 0).toBeGreaterThan(0);
			// The identifying column must be among them, or the row stays linked to the subject.
			expect(r.pseudonymize?.some((c) => c.column === r.subjectColumn)).toBe(true);
		}
	});

	// Only these three carry the columns; an erase or retain rule naming them would be a rule that
	// contradicts its own disposition.
	it("keeps pseudonymize columns off the erase and retain rules", () => {
		for (const r of ERASURE_RULES.filter((x) => x.disposition !== "pseudonymize")) {
			expect(r.pseudonymize).toBeUndefined();
		}
	});

	// Retention against an erasure request is an EXCEPTION to a right, so it has to cite the
	// obligation. "We'd rather keep it" is not one.
	it("makes every retained table cite the obligation that justifies keeping it", () => {
		const retained = ERASURE_RULES.filter((r) => r.disposition === "retain");
		expect(retained.length).toBeGreaterThan(0);
		for (const r of retained) {
			expect(/art\.\s*17\(3\)|statutory|legal-obligation|legal obligation/i.test(r.reason)).toBe(true);
		}
	});

	it("names what each vendor holds and how erasure is requested", () => {
		expect(VENDOR_ERASURES.length).toBeGreaterThan(0);
		for (const v of VENDOR_ERASURES) {
			expect(v.holds.length).toBeGreaterThan(10);
			expect(["api", "manual"]).toContain(v.method);
		}
	});
});

describe("building a plan", () => {
	it("splits the register into the three dispositions and keeps the vendors", () => {
		const plan = buildErasurePlan();
		expect(plan.erase.every((r) => r.disposition === "erase")).toBe(true);
		expect(plan.pseudonymize.every((r) => r.disposition === "pseudonymize")).toBe(true);
		expect(plan.retain.every((r) => r.disposition === "retain")).toBe(true);
		expect(plan.vendors).toEqual(VENDOR_ERASURES);
		expect(plan.blocked).toBe(false);
	});

	// Every rule reaches exactly one bucket. A rule that fell through would be a table nobody
	// decided about — silently kept, and absent from what the subject is shown.
	it("accounts for every rule exactly once", () => {
		const plan = buildErasurePlan();
		const total = plan.erase.length + plan.pseudonymize.length + plan.retain.length;
		expect(total).toBe(ERASURE_RULES.length);
	});

	// THE property that stops a hold becoming a refusal. Under a hold nothing is destroyed, but the
	// paused rules still appear — so the subject can be told what is held and why, rather than
	// receiving a bare "no".
	it("pauses a plan under a legal hold instead of refusing it", () => {
		const plan = buildErasurePlan({ legalHoldReason: "Ongoing chargeback dispute" });
		expect(plan.blocked).toBe(true);
		expect(plan.blockedReason).toBe("Ongoing chargeback dispute");
		expect(plan.erase).toEqual([]);
		expect(plan.pseudonymize).toEqual([]);
		// Nothing is lost from view — every rule is enumerated as retained-for-now.
		expect(plan.retain).toHaveLength(ERASURE_RULES.length);
		// And no vendor is told to erase data we are not erasing.
		expect(plan.vendors).toEqual([]);
	});

	it("treats a blank hold reason as no hold", () => {
		expect(buildErasurePlan({ legalHoldReason: "   " }).blocked).toBe(false);
		expect(buildErasurePlan({ legalHoldReason: null }).blocked).toBe(false);
	});
});

describe("the scope recorded on the case", () => {
	it("records what was erased, what was unlinked and why, and what was kept and why", () => {
		const scope = planToScope(buildErasurePlan(), AT);
		expect(scope.erased.length).toBeGreaterThan(0);
		expect(scope.pseudonymized.every((p) => p.reason.length > 20)).toBe(true);
		expect(scope.retained.every((r) => r.basis.length > 20)).toBe(true);
		expect(scope.vendors.every((v) => v.notifiedAt === AT.toISOString())).toBe(true);
	});

	// Honest until it is true: a vendor asked to erase has not confirmed, and a `manual` one may sit
	// unconfirmed for a while — which is exactly what should be visible on the case.
	it("leaves vendor confirmation null until it actually arrives", () => {
		const scope = planToScope(buildErasurePlan(), AT);
		expect(scope.vendors.every((v) => v.confirmedAt === null)).toBe(true);
	});

	it("records a held plan as retained, with nothing claimed erased", () => {
		const scope = planToScope(buildErasurePlan({ legalHoldReason: "Litigation hold" }), AT);
		expect(scope.erased).toEqual([]);
		expect(scope.pseudonymized).toEqual([]);
		expect(scope.retained).toHaveLength(ERASURE_RULES.length);
	});
});
