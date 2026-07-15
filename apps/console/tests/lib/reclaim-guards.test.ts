// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// These tests guard code that DELETES REAL INFRASTRUCTURE, in an account that also holds prod. So they
// are written adversarially: every test below is an attempt to get `decide()` to delete something it
// must not. A confirmatory test ("the orphan is deleted") proves almost nothing here — the value is
// entirely in the refusals.

import { describe, expect, it } from "vitest";
import {
	assertUsableSelector,
	decide,
	orderForDelete,
	type ReclaimContext,
} from "@/lib/reclaim/guards";
import type { CloudResourceRef } from "@/lib/reclaim/types";

const SELECTOR = {
	key: "alethia_environment-id",
	value: "6f2c1e34-9a77-4d18-8b21-0f5a7c9e4d10",
};
const JOB_START = new Date("2026-07-14T12:00:00Z");

/** A resource that SHOULD be deleted: right label, not in state, created after the job started. */
function orphan(over: Partial<CloudResourceRef> = {}): CloudResourceRef {
	return {
		native_id: "150954914",
		kind: "server",
		name: "acme-prod-7f3a-control-plane-1",
		region: "nbg1",
		created_at: new Date("2026-07-14T12:05:00Z"),
		labels: { "alethia_environment-id": "6f2c1e34-9a77-4d18-8b21-0f5a7c9e4d10" },
		...over,
	};
}

function ctx(over: Partial<ReclaimContext> = {}): ReclaimContext {
	return {
		selector: SELECTOR,
		stateNativeIds: new Set<string>(),
		jobStartedAt: JOB_START,
		...over,
	};
}

describe("assertUsableSelector", () => {
	// No selector means no filter, and no filter means the sweep enumerates — and then deletes from —
	// the entire cloud account. This is the single most dangerous input in the system.
	it("refuses a missing selector", () => {
		expect(() => assertUsableSelector(null)).toThrow(/without a label selector/);
		expect(() => assertUsableSelector(undefined)).toThrow(/without a label selector/);
	});

	it("refuses an empty key or value (a filter that filters nothing)", () => {
		expect(() => assertUsableSelector({ key: "", value: "6f2c1e34-9a77-4d18-8b21-0f5a7c9e4d10" })).toThrow();
		expect(() => assertUsableSelector({ key: "alethia_environment-id", value: "" })).toThrow();
	});

	it("refuses an implausibly broad value that could match another environment by accident", () => {
		expect(() => assertUsableSelector({ key: "alethia_environment-id", value: "prod" })).toThrow(
			/implausibly broad/,
		);
	});

	it("accepts a real environment-id sweep handle", () => {
		expect(() => assertUsableSelector(SELECTOR)).not.toThrow();
	});
});

describe("decide", () => {
	it("deletes a genuine orphan (right label, absent from state, younger than the job)", () => {
		const d = decide(orphan(), ctx());
		expect(d.action).toBe("delete");
		expect(d.reason).toBe("orphan");
	});

	// ── THE REFUSALS. Each of these is a way prod gets destroyed. ──────────────────────────────────

	// The adapter is supposed to filter server-side. If it ever over-returns — a bad predicate, a
	// pagination bug, a cloud API that ignores the filter — that must not become a delete.
	it("REFUSES a resource carrying a DIFFERENT environment's sweep handle", () => {
		const d = decide(orphan({ labels: { "alethia_environment-id": "0000aaaa-bbbb-cccc-dddd-eeeeffff1111" } }), ctx());
		expect(d.action).toBe("keep");
		expect(d.reason).toMatch(/label mismatch/);
	});

	it("REFUSES a resource carrying no labels at all", () => {
		const d = decide(orphan({ labels: {} }), ctx());
		expect(d.action).toBe("keep");
		expect(d.reason).toMatch(/label mismatch/);
	});

	// A resource tofu tracks is not an orphan. Deleting it behind tofu's back corrupts the very state
	// we are protecting — and an ordinary destroy would have handled it anyway.
	it("REFUSES a resource that tofu state already tracks", () => {
		const d = decide(
			orphan(),
			ctx({ stateNativeIds: new Set(["150954914"]) }),
		);
		expect(d.action).toBe("keep");
		expect(d.reason).toMatch(/tracked in tofu state/);
	});

	// The guard that makes pre-existing infrastructure unsweepable no matter what goes wrong upstream.
	// Prod was created long before this job started; it can never be this job's orphan.
	it("REFUSES a resource that predates the job (this is what protects prod)", () => {
		const d = decide(
			orphan({ created_at: new Date("2026-01-01T00:00:00Z") }),
			ctx(),
		);
		expect(d.action).toBe("keep");
		expect(d.reason).toMatch(/predates the job/);
	});

	// An unknown age cannot be proven young. Absence of evidence is not evidence of orphanhood.
	it("REFUSES a resource whose creation time the cloud did not report", () => {
		const d = decide(orphan({ created_at: null }), ctx());
		expect(d.action).toBe("keep");
		expect(d.reason).toMatch(/creation time unknown/);
	});

	// A resource created in the same second the job started is ambiguous; the boundary must not be
	// exclusive in the dangerous direction. Equal timestamps are NOT older, so this deletes — but a
	// resource one millisecond older does not.
	it("REFUSES a resource one millisecond older than the job start", () => {
		const d = decide(
			orphan({ created_at: new Date(JOB_START.getTime() - 1) }),
			ctx(),
		);
		expect(d.action).toBe("keep");
	});
});

describe("orderForDelete", () => {
	// Wrong order makes deletes FAIL (a volume attached to a live server, a network with hosts in it).
	// That is a cleanup-quality problem rather than a safety one, but a sweep that leaves half the
	// resources behind has not solved the billing problem it exists to solve.
	it("puts dependents before their dependencies", () => {
		const order = ["server", "volume", "network"];
		const resources = [
			orphan({ kind: "network", native_id: "n1" }),
			orphan({ kind: "volume", native_id: "v1" }),
			orphan({ kind: "server", native_id: "s1" }),
		];
		expect(orderForDelete(resources, order).map((r) => r.kind)).toEqual([
			"server",
			"volume",
			"network",
		]);
	});

	it("sorts unknown kinds last rather than dropping them", () => {
		const resources = [
			orphan({ kind: "mystery", native_id: "m1" }),
			orphan({ kind: "server", native_id: "s1" }),
		];
		const out = orderForDelete(resources, ["server", "volume"]);
		expect(out.map((r) => r.kind)).toEqual(["server", "mystery"]);
		expect(out).toHaveLength(2);
	});
});
