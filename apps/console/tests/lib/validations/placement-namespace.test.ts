// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6551 — a namespace-placed environment may not use a namespace the platform or the host environment
// uses on the shared cluster. The console half of the rule; the runner half is Go
// `argocd.PlacementNamespaceReason` over the same JSON (parity: byo-reserved-namespaces.test.ts).

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { environmentSpecProblem } from "@/lib/queries/projects";
import {
	BYO_RESERVED_NAMESPACES,
	byoReservedNamespaceReason,
} from "@/lib/validations/byo-reserved-namespaces";
import {
	PLACEMENT_HOST_NAMESPACE_REASON,
	effectivePlacementNamespace,
	placementNamespaceMessage,
	placementNamespaceReason,
} from "@/lib/validations/placement-namespace";
import { environmentMatrixSchema } from "@/lib/validations/project-form.schema";

const REPO_ROOT = resolve(__dirname, "../../../../..");

const ALL_RESERVED = [...new Set(BYO_RESERVED_NAMESPACES.groups.flatMap((g) => g.namespaces))];

/** One namespace-placed matrix entry, with a dedicated host beside it. */
function matrix(entry: { name: string; namespace?: string; placement_mode?: "namespace" | "vcluster" }) {
	return [
		{ name: "prod", stage: "production" as const, placement_mode: "dedicated" as const, is_default: true },
		{ stage: "development" as const, placement_mode: "namespace" as const, ...entry },
	];
}

describe("placementNamespaceReason", () => {
	it("refuses every BYO-reserved name and prefix, and names the namespace in the message", () => {
		expect(ALL_RESERVED.length).toBeGreaterThan(20);
		for (const ns of ALL_RESERVED) {
			expect(placementNamespaceReason(ns, [])).not.toBeNull();
			expect(placementNamespaceMessage(ns, [])).toContain(`“${ns}”`);
		}
		for (const p of BYO_RESERVED_NAMESPACES.prefixes) {
			expect(placementNamespaceReason(`${p.prefix}x`, [])).toBe(p.reason);
		}
	});

	it("refuses the names the issue lists", () => {
		for (const ns of ["default", "argocd", "kube-system", "kube-flannel", "alethia-byo-db-users"]) {
			expect(placementNamespaceReason(ns, [])).not.toBeNull();
		}
	});

	it("refuses a BYO chart's byo- namespace — for a placement only, never for a BYO chart", () => {
		expect(BYO_RESERVED_NAMESPACES.placementPrefixes.map((p) => p.prefix)).toContain("byo-");
		expect(placementNamespaceReason("byo-payments", [])).not.toBeNull();
		expect(byoReservedNamespaceReason("byo-payments")).toBeNull();
	});

	it("refuses a namespace the host environment's own BYO chart chose, with the host reason", () => {
		expect(placementNamespaceReason("payments", ["payments"])).toBe(PLACEMENT_HOST_NAMESPACE_REASON);
		expect(placementNamespaceReason("payments", [])).toBeNull();
	});

	it("gives the host reason the runner gives", () => {
		const go = readFileSync(resolve(REPO_ROOT, "packages/core/argocd/placement_reserved.go"), "utf8");
		const m = /const PlacementHostNamespaceReason = "([^"]+)"/.exec(go);
		expect(m?.[1]).toBe(PLACEMENT_HOST_NAMESPACE_REASON);
	});

	it("accepts ordinary namespaces — the legacy Preview environment's included", () => {
		for (const ns of ["team-web", "preview", "preview-pr-42", "staging", "my-default", "byo"]) {
			expect(placementNamespaceReason(ns, ["payments"])).toBeNull();
		}
	});
});

describe("effectivePlacementNamespace", () => {
	it("is the namespace when there is one, else the slug of the name", () => {
		expect(effectivePlacementNamespace({ name: "dev", namespace: "team-web" })).toBe("team-web");
		expect(effectivePlacementNamespace({ name: "argocd", namespace: null })).toBe("argocd");
		expect(effectivePlacementNamespace({ name: "argocd" })).toBe("argocd");
	});
});

describe("project create — the matrix schema and the fan-out", () => {
	it("refuses a namespace placement into a reserved namespace, on the namespace field", () => {
		const parsed = environmentMatrixSchema.safeParse(matrix({ name: "dev", namespace: "argocd" }));
		expect(parsed.success).toBe(false);
		const issue = parsed.error?.issues[0];
		expect(issue?.path).toEqual([1, "namespace"]);
		expect(issue?.message).toMatch(/“argocd” is reserved on the host cluster/);
		expect(environmentSpecProblem({ name: "dev", namespace: "argocd", placement_mode: "namespace" })).toMatch(
			/reserved on the host cluster/,
		);
	});

	it("refuses one with no namespace whose NAME would be its namespace", () => {
		expect(environmentMatrixSchema.safeParse(matrix({ name: "argocd" })).success).toBe(false);
		expect(environmentSpecProblem({ name: "argocd", placement_mode: "namespace" })).not.toBeNull();
	});

	it("does not apply to a dedicated or vcluster environment", () => {
		expect(environmentMatrixSchema.safeParse(matrix({ name: "dev", namespace: "default", placement_mode: "vcluster" })).success).toBe(true);
		expect(environmentSpecProblem({ name: "dev", namespace: "default", placement_mode: "vcluster" })).toBeNull();
		expect(environmentSpecProblem({ name: "argocd", placement_mode: "dedicated" })).toBeNull();
	});

	it("accepts an ordinary namespace placement", () => {
		expect(environmentMatrixSchema.safeParse(matrix({ name: "dev", namespace: "team-web" })).success).toBe(true);
		expect(environmentMatrixSchema.safeParse(matrix({ name: "preview", namespace: "preview" })).success).toBe(true);
		expect(environmentSpecProblem({ name: "dev", namespace: "team-web", placement_mode: "namespace" })).toBeNull();
	});
});
