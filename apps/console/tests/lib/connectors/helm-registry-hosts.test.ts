// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The chart-repo host rules. What these pin is a CROSS-LANGUAGE contract: the URL the console
// resolves for a selection has to be byte-identical to the one the Go provider seeds as the ArgoCD
// repository credential, because ArgoCD binds an Application to a credential by repoURL prefix. A
// drift here is an auth failure at deploy with nothing visibly wrong on either side alone.

import { describe, expect, it } from "vitest";
import {
	duplicateHelmRegistryUrls,
	HELM_REGISTRY_HOST_RULES,
	helmRegistryServesHost,
	helmRegistryUrl,
	isSelectableHelmRegistry,
	ociHostOf,
} from "@/lib/connectors/helm-registry-hosts";
import { getProvidersForCategory } from "@/lib/connectors/registry.generated";

describe("host rules", () => {
	// Drift guard: the host lives in the Go provider, not the catalog, so a new chart-repo connector
	// resolves to an empty URL until someone adds its rule here. Fail loudly rather than let it
	// silently render blank in the picker.
	it("covers every catalogued helm_registry provider", () => {
		const slugs = getProvidersForCategory("helm_registry").map((p) => p.slug);
		expect(slugs.length).toBeGreaterThan(0);
		for (const slug of slugs) {
			expect(HELM_REGISTRY_HOST_RULES[slug], `no host rule for ${slug}`).toBeDefined();
		}
	});

	it("marks the ECR rows unselectable while they're coming_soon", () => {
		expect(isSelectableHelmRegistry("oci-ecr")).toBe(false);
		expect(isSelectableHelmRegistry("oci-public-ecr")).toBe(false);
		expect(isSelectableHelmRegistry("oci-github-cr")).toBe(true);
		expect(isSelectableHelmRegistry(null)).toBe(false);
	});
});

describe("ociHostOf", () => {
	it("reads the host of an oci reference and ignores anything else", () => {
		expect(ociHostOf("oci://ghcr.io/acme/payments")).toBe("ghcr.io");
		expect(ociHostOf("oci://GHCR.io/acme/payments")).toBe("ghcr.io");
		expect(ociHostOf("oci://rg.fr-par.scw.cloud/charts/api")).toBe("rg.fr-par.scw.cloud");
		expect(ociHostOf("https://github.com/acme/charts")).toBeNull();
		expect(ociHostOf("oci://")).toBeNull();
		expect(ociHostOf(null)).toBeNull();
	});
});

describe("helmRegistryUrl", () => {
	// Must equal what packages/core/categories/helm_registry_*.go seeds — ArgoCD matches an
	// Application to its credential by repoURL prefix, so a mismatch here is an auth failure there.
	it("resolves the URL the runner will seed", () => {
		expect(helmRegistryUrl({ provider: "oci-github-cr" })).toBe("oci://ghcr.io");
		expect(helmRegistryUrl({ provider: "oci-docker-hub" })).toBe(
			"oci://registry-1.docker.io",
		);
		expect(helmRegistryUrl({ provider: "oci-gitlab-cr" })).toBe(
			"oci://registry.gitlab.com",
		);
		expect(
			helmRegistryUrl({
				provider: "oci-gitlab-cr",
				provider_config: { registry_host: "gitlab.acme.io" },
			}),
		).toBe("oci://gitlab.acme.io");
		expect(
			helmRegistryUrl({
				provider: "helm-https",
				provider_config: { repo_url: "https://charts.acme.io" },
			}),
		).toBe("https://charts.acme.io");
		expect(helmRegistryUrl({ provider: "oci-generic-cr" })).toBe("");
		expect(helmRegistryUrl({ provider: null })).toBe("");
	});
});

describe("helmRegistryServesHost", () => {
	it("matches the host a chart is addressed by, including registry aliases", () => {
		const ghcr = { provider: "oci-github-cr", provider_config: {} };
		expect(helmRegistryServesHost(ghcr, "ghcr.io")).toBe(true);
		expect(helmRegistryServesHost(ghcr, "GHCR.IO")).toBe(true);
		expect(helmRegistryServesHost(ghcr, "registry.acme.io")).toBe(false);

		// `oci://docker.io/…` and `oci://registry-1.docker.io/…` are the same registry, so a Docker
		// Hub selection covers a chart written either way.
		const hub = { provider: "oci-docker-hub", provider_config: {} };
		expect(helmRegistryServesHost(hub, "registry-1.docker.io")).toBe(true);
		expect(helmRegistryServesHost(hub, "docker.io")).toBe(true);
	});

	it("matches a wildcard provider only once its host is configured", () => {
		const blank = { provider: "oci-generic-cr", provider_config: {} };
		expect(helmRegistryServesHost(blank, "harbor.acme.io")).toBe(false);
		expect(
			helmRegistryServesHost(
				{ ...blank, provider_config: { registry_host: "harbor.acme.io" } },
				"harbor.acme.io",
			),
		).toBe(true);
	});

	it("never serves an oci host from a classic https repo", () => {
		expect(
			helmRegistryServesHost(
				{
					provider: "helm-https",
					provider_config: { repo_url: "https://charts.acme.io" },
				},
				"charts.acme.io",
			),
		).toBe(false);
	});
});

describe("duplicateHelmRegistryUrls", () => {
	// The runner names the seeded Secret from a hash of the URL, so two rows on one URL collapse
	// into a single credential without warning.
	it("flags selections that resolve to the same URL", () => {
		const dupes = duplicateHelmRegistryUrls([
			{ name: "a", provider: "oci-github-cr", provider_config: {} },
			{
				name: "b",
				provider: "oci-generic-cr",
				provider_config: { registry_host: "ghcr.io" },
			},
			{ name: "c", provider: "oci-docker-hub", provider_config: {} },
		]);
		expect(dupes).toEqual(["oci://ghcr.io"]);
	});

	it("ignores unconfigured rows", () => {
		expect(
			duplicateHelmRegistryUrls([
				{ name: "a", provider: "oci-generic-cr", provider_config: {} },
				{ name: "b", provider: "oci-generic-cr", provider_config: {} },
			]),
		).toEqual([]);
	});
});
