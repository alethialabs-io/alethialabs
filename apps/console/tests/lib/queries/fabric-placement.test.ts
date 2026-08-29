// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The create-matrix fan-out used to mint a Fabric literally named `shared` to carry every
// namespace/vcluster environment. No environment owned it, so nothing ever provisioned it, and
// `deploy_namespace.go` failed closed on every tier placed there: "the Fabric's cluster must be
// provisioned (a 'dedicated' env owning the Fabric) before a namespace env can be placed onto it".
//
// It survived because the only coverage of the fan-out was an integration test needing real
// Postgres, so the decision itself was never asserted. `planFabricPlacement` is pure precisely so
// that these cases cost nothing to run.

import { describe, expect, it } from "vitest";
import {
	type EnvironmentSpec,
	planFabricPlacement,
} from "@/lib/queries/projects";

const env = (
	name: string,
	placement_mode: EnvironmentSpec["placement_mode"],
	is_default = false,
): EnvironmentSpec => ({
	name,
	stage: placement_mode === "dedicated" ? "production" : "development",
	placement_mode,
	is_default,
});

describe("planFabricPlacement", () => {
	it("creates one Fabric per dedicated env and none for shared placements", () => {
		const specs = [
			env("production", "dedicated", true),
			env("staging", "dedicated"),
			env("dev", "namespace"),
			env("preview", "namespace"),
		];
		const { fabricNames } = planFabricPlacement(specs);
		expect(fabricNames).toEqual(["production", "staging"]);
		expect(fabricNames).not.toContain("shared");
	});

	it("hosts shared placements on the DEFAULT dedicated env's Fabric", () => {
		// The console's own default catalog. Before the fix, dev and preview landed on an orphan
		// `shared` Fabric and could never deploy.
		const specs = [
			env("production", "dedicated", true),
			env("staging", "dedicated"),
			env("dev", "namespace"),
			env("preview", "namespace"),
		];
		const { hostFor } = planFabricPlacement(specs);
		expect(hostFor(specs[0])).toBe("production");
		expect(hostFor(specs[1])).toBe("staging");
		expect(hostFor(specs[2])).toBe("production");
		expect(hostFor(specs[3])).toBe("production");
	});

	it("falls back to the first dedicated env when the default is a shared placement", () => {
		// The placement dropdown lets the required default env be set to `namespace`, so this shape
		// is reachable from the UI and must still resolve onto something provisionable.
		const specs = [
			env("production", "namespace", true),
			env("staging", "dedicated"),
			env("dev", "vcluster"),
		];
		const { fabricNames, hostFor } = planFabricPlacement(specs);
		expect(fabricNames).toEqual(["staging"]);
		expect(hostFor(specs[0])).toBe("staging");
		expect(hostFor(specs[2])).toBe("staging");
	});

	it("places a vcluster tier on the host Fabric, not one of its own", () => {
		// The demo topology: prod dedicated, staging as a vcluster, three dev namespaces — five
		// environments, ONE cluster.
		const specs = [
			env("prod", "dedicated", true),
			env("staging", "vcluster"),
			env("dev-1", "namespace"),
			env("dev-2", "namespace"),
			env("dev-3", "namespace"),
		];
		const { fabricNames, hostFor } = planFabricPlacement(specs);
		expect(fabricNames).toEqual(["prod"]);
		for (const s of specs) expect(hostFor(s)).toBe("prod");
	});

	it("refuses a matrix with no dedicated env, because nothing would provision a cluster", () => {
		// Exactly the command printed in demos/RUNBOOK.md and the enterprise-demo tutorial. It built
		// a project that could never apply; now it fails at creation with the reason.
		const specs = [env("dev", "namespace", true), env("staging", "vcluster")];
		expect(() => planFabricPlacement(specs)).toThrow(/must be `dedicated`/);
	});

	it("allows an all-dedicated matrix", () => {
		const specs = [env("prod", "dedicated", true), env("staging", "dedicated")];
		const { fabricNames, hostFor } = planFabricPlacement(specs);
		expect(fabricNames).toEqual(["prod", "staging"]);
		expect(hostFor(specs[1])).toBe("staging");
	});
});
