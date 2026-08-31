// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { EXTERNAL_DNS_ADDON_SA } from "@/lib/addons/catalog";
import { INFRA_IDENTITY_PLACEHOLDER } from "@/lib/addons/catalog-export";

const repo = (...p: string[]) => resolve(__dirname, "../../../../..", ...p);

/**
 * Three literals, three languages, one contract — and every way they can disagree is SILENT.
 *
 * The console decides the ServiceAccount name and the sentinel; the Go runner looks for that
 * sentinel; three tofu templates trust that ServiceAccount. Nothing but these strings joins them,
 * and a mismatch never errors:
 *
 *  - a drifted sentinel means the runner finds nothing to substitute, so the annotation ships
 *    holding the literal placeholder — external-dns constructs its provider, reports Healthy, and
 *    writes nothing;
 *  - a drifted ServiceAccount name means the cloud refuses the token exchange for a subject nobody
 *    trusts, which on AWS is a per-record AccessDenied the pod survives.
 *
 * Both end in "installed, Healthy, inert", which is the state this whole change exists to remove.
 */
describe("external-dns add-on identity: the cross-language literals agree", () => {
	it("the Go runner looks for exactly the sentinel the fixture writes", () => {
		const go = readFileSync(repo("packages/core/argocd/addon_identity.go"), "utf8");
		expect(go).toContain(`CloudIdentityPlaceholder = "${INFRA_IDENTITY_PLACEHOLDER}"`);
	});

	it.each([
		["aws", "infra/templates/project/aws/modules/eks/irsa.tf", `"external-dns:${EXTERNAL_DNS_ADDON_SA}"`],
		["gcp", "infra/templates/project/gcp/workload-identity.tf", `[external-dns/${EXTERNAL_DNS_ADDON_SA}]`],
		["azure", "infra/templates/project/azure/workload-identity.tf", `system:serviceaccount:external-dns:${EXTERNAL_DNS_ADDON_SA}`],
	])("%s trusts the ServiceAccount the catalog actually names", (_cloud, path, needle) => {
		expect(readFileSync(repo(path), "utf8")).toContain(needle);
	});

	it("the add-on's ServiceAccount is NOT the platform rail's", () => {
		// The rail owns external-dns/external-dns-sa in the same namespace. Naming it here would put
		// two ArgoCD Applications on one object — on a cell that is currently proven.
		expect(EXTERNAL_DNS_ADDON_SA).not.toBe("external-dns-sa");
		const rail = readFileSync(repo("infra/templates/argocd/external-dns.yaml"), "utf8");
		expect(rail).toContain("name: external-dns-sa");
	});
});
