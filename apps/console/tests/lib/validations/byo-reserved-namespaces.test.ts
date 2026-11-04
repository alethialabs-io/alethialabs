// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6439 — a BYO chart's destination namespace is never a reserved platform namespace.
//
// Two pins and the behaviour:
//   1. PARITY: lib/validations/byo-reserved-namespaces.ts deep-equals the runner's list,
//      packages/core/argocd/byo_reserved_namespaces.json, so the form and the deploy refuse the same
//      names. A drift in either direction reds here.
//   2. CATALOGUE: the marketplace group equals the namespaces `ADDON_CATALOG` installs into, in both
//      directions — a new add-on in a new namespace reds until it is reserved.
//   3. The form and attach schemas refuse every reserved name and accept ordinary ones.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ADDON_CATALOG } from "@/lib/addons/catalog";
import { byoChartAttachSchema, byoChartFormSchema } from "@/lib/validations/byo-charts";
import {
	BYO_RESERVED_NAMESPACES,
	byoReservedNamespaceMessage,
	byoReservedNamespaceReason,
} from "@/lib/validations/byo-reserved-namespaces";

const REPO_ROOT = resolve(__dirname, "../../../../..");

/**
 * The runner's list, read from the file the Go binary embeds. `.strict()` refuses a key this test does
 * not know, so a field added to the JSON cannot pass parity by being silently dropped here.
 */
function runnerList() {
	const raw: unknown = JSON.parse(
		readFileSync(resolve(REPO_ROOT, "packages/core/argocd/byo_reserved_namespaces.json"), "utf8"),
	);
	return z
		.object({
			$comment: z.string(),
			groups: z.array(
				z.object({ id: z.string(), reason: z.string(), namespaces: z.array(z.string()) }).strict(),
			),
			prefixes: z.array(z.object({ prefix: z.string(), reason: z.string() }).strict()),
		})
		.strict()
		.parse(raw);
}

/** The namespaces of one group of the console mirror, failing when the group is gone. */
function group(id: string): readonly string[] {
	const g = BYO_RESERVED_NAMESPACES.groups.find((x) => x.id === id);
	if (!g) throw new Error(`no ${id} group in BYO_RESERVED_NAMESPACES`);
	return g.namespaces;
}

/** Every exact reserved name, across all groups. */
const ALL_RESERVED = [...new Set(BYO_RESERVED_NAMESPACES.groups.flatMap((g) => g.namespaces))];

/** A valid git-source form value targeting `namespace`. */
function formValue(namespace: string) {
	return {
		source: "git" as const,
		repoUrl: "https://github.com/acme/charts",
		chartPath: "charts/api",
		namespace,
	};
}

/** A valid attach input targeting `namespace`. */
function attachValue(namespace: string) {
	return {
		projectId: "p1",
		id: "api",
		repoUrl: "https://github.com/acme/charts",
		chartPath: "charts/api",
		namespace,
	};
}

describe("BYO reserved namespaces — one list, two readers", () => {
	it("the console mirror deep-equals the runner's byo_reserved_namespaces.json", () => {
		const runner = runnerList();
		expect(BYO_RESERVED_NAMESPACES).toEqual({ groups: runner.groups, prefixes: runner.prefixes });
	});

	it("the marketplace group is exactly the namespaces ADDON_CATALOG installs into", () => {
		const catalogue = [...new Set(ADDON_CATALOG.map((a) => a.namespace))].sort();
		expect(catalogue.length).toBeGreaterThan(0);
		expect([...group("marketplaceAddOns")].sort()).toEqual(catalogue);
	});

	it("names the namespaces the issue lists explicitly", () => {
		for (const ns of ["kube-system", "kube-public", "kube-node-lease", "argocd"]) {
			expect(byoReservedNamespaceReason(ns)).not.toBeNull();
		}
	});
});

describe("byoReservedNamespaceReason", () => {
	it("refuses every reserved name and every reserved prefix", () => {
		for (const ns of ALL_RESERVED) expect(byoReservedNamespaceReason(ns)).not.toBeNull();
		for (const ns of ["kube-flannel", "vcluster-dev"]) {
			expect(byoReservedNamespaceReason(ns)).not.toBeNull();
		}
	});

	it("gives an exact name its group's reason rather than a prefix's", () => {
		expect(byoReservedNamespaceReason("kube-system")).toBe(
			BYO_RESERVED_NAMESPACES.groups.find((g) => g.id === "kubernetes")?.reason,
		);
	});

	it("accepts ordinary names, including ones that only contain a reserved word", () => {
		for (const ns of [
			"default",
			"payments",
			"kubernetes-dashboard",
			"my-kube-system",
			"vault-client",
			"vcluster",
		]) {
			expect(byoReservedNamespaceReason(ns)).toBeNull();
			expect(byoReservedNamespaceMessage(ns)).toBeNull();
		}
	});

	it("says what to do in the message", () => {
		expect(byoReservedNamespaceMessage("argocd")).toMatch(
			/“argocd” is reserved for the platform: .+\. Choose a namespace of your own\./,
		);
	});
});

describe("the BYO chart schemas", () => {
	it("refuse every reserved namespace on the form and on the attach action, on the namespace field", () => {
		for (const ns of [...ALL_RESERVED, "kube-flannel", "vcluster-dev"]) {
			for (const result of [
				byoChartFormSchema.safeParse(formValue(ns)),
				byoChartAttachSchema.safeParse(attachValue(ns)),
			]) {
				// The namespace rides in the compared value, so a failure names which one.
				expect({ ns, success: result.success }).toEqual({ ns, success: false });
				if (!result.success) {
					const issue = result.error.issues.find((i) => i.path.join(".") === "namespace");
					expect({ ns, message: issue?.message ?? "" }).toEqual({
						ns,
						message: expect.stringContaining("reserved for the platform"),
					});
				}
			}
		}
	});

	it("refuse a reserved namespace on an OCI chart too", () => {
		const result = byoChartFormSchema.safeParse({
			source: "oci",
			repoUrl: "oci://ghcr.io/acme/charts/api",
			namespace: "monitoring",
		});
		expect(result.success).toBe(false);
	});

	it("accept an ordinary namespace and a blank one (the default)", () => {
		for (const ns of ["payments", ""]) {
			expect({ ns, success: byoChartFormSchema.safeParse(formValue(ns)).success }).toEqual({
				ns,
				success: true,
			});
			expect({ ns, success: byoChartAttachSchema.safeParse(attachValue(ns)).success }).toEqual({
				ns,
				success: true,
			});
		}
		expect(
			byoChartAttachSchema.safeParse({
				projectId: "p1",
				id: "api",
				repoUrl: "https://github.com/acme/charts",
				chartPath: "charts/api",
			}).success,
		).toBe(true);
	});
});
