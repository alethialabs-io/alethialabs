// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// THE SEEDED DRIFT ROW IS HELD AGAINST THE CODE THAT READS IT (#5865).
//
// `environment_drift.details` is read by `getEnvironmentComponentStatus`, the action the project
// shell polls on every project route, which hands each detail to `attributeDrift` →
// `kindForResourceType(detail.type)`. A seeded row whose details lack `type` makes that read throw
// (`Cannot read properties of undefined (reading 'startsWith')`), so the action answers 500 on
// every route of a seeded project. The runner writes details through `drift.Analyze`, whose
// `Detail` struct always carries `address`, `type` and `kind`; the seeder must write the same.

import { describe, expect, it } from "vitest";
import { attributeDrift, kindForResourceType } from "../../lib/canvas/drift-map";
import { seedDriftDetails } from "../../e2e/helpers/seed";

describe("seedDriftDetails", () => {
	it("writes one detail per drifted resource", () => {
		expect(seedDriftDetails(0)).toEqual([]);
		expect(seedDriftDetails(2)).toHaveLength(2);
		expect(seedDriftDetails(5)).toHaveLength(5);
	});

	it("writes the shape the runner writes: address, a recognised type, and a kind", () => {
		for (const detail of seedDriftDetails(3)) {
			expect(typeof detail.address).toBe("string");
			expect(detail.address.startsWith(`${detail.type}.`)).toBe(true);
			expect(kindForResourceType(detail.type)).not.toBeNull();
			expect(["modified", "deleted", "other"]).toContain(detail.kind);
		}
	});

	it("is read by the component-status drift attribution without throwing", () => {
		const targets = [
			{ key: "network", kind: "network" as const },
			{ key: "cluster", kind: "cluster" as const },
		];
		const { byKey, unattributed } = attributeDrift(seedDriftDetails(2), targets);
		expect(unattributed).toEqual([]);
		expect([...byKey.values()].flat()).toHaveLength(2);
	});
});
