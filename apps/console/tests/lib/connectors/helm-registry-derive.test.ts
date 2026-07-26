// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The chart-repo derivation rules. These pin the two things that make auto-derive safe to run
// without asking: it is DETERMINISTIC (same charts + same connectors → same rows), and it is
// CONSERVATIVE (it never touches a row the user already has, and it refuses to guess when more than
// one connected connector could serve a host).

import { describe, expect, it } from "vitest";
import {
	deriveHelmRegistries,
	duplicateHelmRegistryUrls,
	HELM_REGISTRY_HOST_RULES,
	helmRegistryUrl,
	isSelectableHelmRegistry,
	ociHostOf,
	type HelmRegistryItem,
} from "@/lib/connectors/helm-registry-derive";
import { getProvidersForCategory } from "@/lib/connectors/registry.generated";

describe("host rules", () => {
	// Drift guard: the host lives in the Go provider, not the catalog, so a new chart-repo connector
	// can only be derived if someone adds its rule here. Fail loudly rather than silently never
	// matching it.
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
		expect(helmRegistryUrl({ name: "a", provider: "oci-github-cr" })).toBe("oci://ghcr.io");
		expect(helmRegistryUrl({ name: "a", provider: "oci-docker-hub" })).toBe(
			"oci://registry-1.docker.io",
		);
		expect(helmRegistryUrl({ name: "a", provider: "oci-gitlab-cr" })).toBe(
			"oci://registry.gitlab.com",
		);
		expect(
			helmRegistryUrl({
				name: "a",
				provider: "oci-gitlab-cr",
				provider_config: { registry_host: "gitlab.acme.io" },
			}),
		).toBe("oci://gitlab.acme.io");
		expect(
			helmRegistryUrl({
				name: "a",
				provider: "helm-https",
				provider_config: { repo_url: "https://charts.acme.io" },
			}),
		).toBe("https://charts.acme.io");
		expect(helmRegistryUrl({ name: "a", provider: "oci-generic-cr" })).toBe("");
		expect(helmRegistryUrl({ name: "a", provider: null })).toBe("");
	});
});

describe("deriveHelmRegistries", () => {
	const derive = (
		chartRepos: (string | null)[],
		connectedSlugs: string[],
		existing: HelmRegistryItem[] = [],
	) => deriveHelmRegistries({ chartRepos, connectedSlugs, existing });

	it("matches a fixed host exactly and stores no redundant config", () => {
		const { additions, unresolved } = derive(
			["oci://ghcr.io/acme/payments"],
			["oci-github-cr", "oci-generic-cr"],
		);
		expect(unresolved).toEqual([]);
		expect(additions).toEqual([
			{ name: "ghcr-io", provider: "oci-github-cr", provider_config: {} },
		]);
	});

	it("accepts an alias spelling of a fixed host", () => {
		const { additions } = derive(["oci://docker.io/acme/api"], ["oci-docker-hub"]);
		expect(additions[0].provider).toBe("oci-docker-hub");
	});

	it("prefers the suffix-hinted provider over a generic one", () => {
		const { additions, unresolved } = derive(
			["oci://rg.fr-par.scw.cloud/charts/api"],
			["oci-generic-cr", "oci-scaleway-cr"],
		);
		expect(unresolved).toEqual([]);
		expect(additions).toEqual([
			{
				name: "rg-fr-par-scw-cloud",
				provider: "oci-scaleway-cr",
				provider_config: { registry_host: "rg.fr-par.scw.cloud" },
			},
		]);
	});

	it("takes the host from the chart URL for the single connected any-host provider", () => {
		const { additions } = derive(["oci://harbor.acme.io/charts/api"], ["oci-generic-cr"]);
		expect(additions).toEqual([
			{
				name: "harbor-acme-io",
				provider: "oci-generic-cr",
				provider_config: { registry_host: "harbor.acme.io" },
			},
		]);
	});

	it("refuses to guess when two any-host providers could serve it", () => {
		const { additions, unresolved } = derive(
			["oci://harbor.acme.io/charts/api"],
			["oci-generic-cr", "oci-scaleway-cr"],
		);
		expect(additions).toEqual([]);
		expect(unresolved).toEqual([
			{
				host: "harbor.acme.io",
				reason: "ambiguous",
				candidates: ["oci-generic-cr", "oci-scaleway-cr"],
			},
		]);
	});

	it("reports a host nothing connected can serve", () => {
		const { additions, unresolved } = derive(["oci://ghcr.io/acme/api"], ["oci-docker-hub"]);
		expect(additions).toEqual([]);
		expect(unresolved).toEqual([
			{ host: "ghcr.io", reason: "no_connector", candidates: [] },
		]);
	});

	it("leaves an existing selection alone — an explicit override is durable", () => {
		const existing: HelmRegistryItem[] = [
			{
				name: "my-ghcr",
				provider: "oci-generic-cr",
				provider_config: { registry_host: "ghcr.io" },
			},
		];
		const { additions, unresolved } = derive(
			["oci://ghcr.io/acme/api"],
			["oci-github-cr", "oci-generic-cr"],
			existing,
		);
		expect(additions).toEqual([]);
		expect(unresolved).toEqual([]);
	});

	it("never derives a classic HTTPS repo — it isn't addressed as oci://", () => {
		const { additions, unresolved } = derive(
			["https://charts.acme.io", "https://github.com/acme/charts"],
			["helm-https"],
		);
		expect(additions).toEqual([]);
		expect(unresolved).toEqual([]);
	});

	it("skips coming_soon providers even when 'connected'", () => {
		const { additions, unresolved } = derive(
			["oci://123.dkr.ecr.eu-west-1.amazonaws.com/charts/api"],
			["oci-ecr"],
		);
		expect(additions).toEqual([]);
		expect(unresolved[0].reason).toBe("no_connector");
	});

	it("derives one row per host and keeps names unique", () => {
		const { additions } = derive(
			[
				"oci://ghcr.io/acme/api",
				"oci://ghcr.io/acme/web",
				"oci://harbor.acme.io/charts/api",
			],
			["oci-github-cr", "oci-generic-cr"],
			[{ name: "ghcr-io", provider: "helm-https", provider_config: { repo_url: "" } }],
		);
		// The existing row is named `ghcr-io` but resolves to no host, so ghcr.io is still uncovered
		// and the derived row must not collide with it — (project, environment, name) is UNIQUE.
		expect(additions.map((r) => r.name)).toEqual(["ghcr-io-2", "harbor-acme-io"]);
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
