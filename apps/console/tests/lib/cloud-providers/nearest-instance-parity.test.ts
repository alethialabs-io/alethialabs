// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The TypeScript half of the Go/TS nearest-instance parity lock (#5267).
//
// The cluster card says what a `node_size` resolves to ("4 vCPU / 16 GB → e2-standard-4") through
// the generated catalog's `nearestInstance`; the deploy buys what Go's `NearestInstance` picks. The
// Go answers over a fixed grid live in packages/core/catalog/testdata/nearest-instance-parity.json,
// and TestNearestInstanceParityFixture fails when Go stops matching that file. This test fails when
// TypeScript does — so a change to either rule reds until both agree.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { nearestInstance } from "@/lib/cloud-providers/generated/catalog";

const REPO_ROOT = resolve(__dirname, "../../../../..");
const FIXTURE = "packages/core/catalog/testdata/nearest-instance-parity.json";

interface ParityCase {
	provider: string;
	vcpu: number;
	memory_gb: number;
	family: string;
	want: string;
}

/** Reads the Go-written fixture, failing loudly on a row of the wrong shape. */
function readCases(): ParityCase[] {
	const raw: unknown = JSON.parse(readFileSync(resolve(REPO_ROOT, FIXTURE), "utf8"));
	if (!Array.isArray(raw)) throw new Error(`${FIXTURE} is not an array`);
	return raw.map((r: unknown, i) => {
		if (
			typeof r !== "object" ||
			r === null ||
			!("provider" in r && typeof r.provider === "string") ||
			!("vcpu" in r && typeof r.vcpu === "number") ||
			!("memory_gb" in r && typeof r.memory_gb === "number") ||
			!("family" in r && typeof r.family === "string") ||
			!("want" in r && typeof r.want === "string")
		) {
			throw new Error(`${FIXTURE}[${i}] is not a parity case`);
		}
		return { provider: r.provider, vcpu: r.vcpu, memory_gb: r.memory_gb, family: r.family, want: r.want };
	});
}

describe("nearestInstance agrees with the Go resolver", () => {
	const cases = readCases();

	it("has a fixture covering every cloud", () => {
		expect(new Set(cases.map((c) => c.provider))).toEqual(
			new Set(["aws", "gcp", "azure", "hetzner", "alibaba"]),
		);
	});

	it("picks the machine Go picks, for every request in the fixture", () => {
		// Collected, then compared once — a single drift otherwise hides every other.
		const disagreements = cases
			.map((c) => ({
				...c,
				got: nearestInstance(c.provider, c.vcpu, c.memory_gb, c.family || undefined)?.value,
			}))
			.filter((c) => c.got !== c.want)
			.map((c) => `${c.provider} ${c.vcpu}/${c.memory_gb} ${c.family || "-"}: ts=${c.got} go=${c.want}`);
		expect(disagreements).toEqual([]);
	});
});
