// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #5268: every path that CREATES a cluster in the console either leaves `cluster_version` unset — so
// the Go resolver (`ResolveK8sVersion`) picks the catalog default for the cloud it is deployed on —
// or writes a version the catalog lists for that cloud. The blank-project path hard-coded "1.31", a
// minor in no cloud's `k8s_versions`, and the resolver passes an explicit version through untouched.

import { describe, expect, it } from "vitest";
import {
	buildCreateInput,
	buildEmptyCreateInput,
	type QuickEnvironment,
	TEMPLATE_OPTIONS,
} from "@/components/create-project/templates";
import { buildDefaultFormValues } from "@/components/design-project/source-project";
import { NODE_REGISTRY } from "@/components/design-project/canvas/graph/node-registry";
import { K8S_VERSIONS } from "@/lib/cloud-providers";
import { CLOUD_PROVIDER_SLUGS } from "@/lib/cloud-providers/provider-slug";

const ENV: QuickEnvironment = { name: "production", stage: "production", region: "eu-west-1" };

describe("create paths — cluster_version is unset or in the catalog (#5268)", () => {
	it("the blank project leaves it unset, so the resolver picks the catalog default at provision time", () => {
		const input = buildEmptyCreateInput({ projectName: "p", defaultEnvironment: ENV });
		expect(input.cluster.cluster_version).toBeUndefined();
		expect("cluster_version" in input.cluster).toBe(false);
	});

	it.each(CLOUD_PROVIDER_SLUGS)("every template on %s writes a version the catalog lists", (provider) => {
		for (const { id } of TEMPLATE_OPTIONS) {
			const input = buildCreateInput({
				projectName: "p",
				template: id,
				provider,
				cloudIdentityId: "00000000-0000-0000-0000-000000000001",
				defaultEnvironment: ENV,
			});
			expect(K8S_VERSIONS[provider]).toContain(input.cluster.cluster_version);
		}
	});

	it.each(CLOUD_PROVIDER_SLUGS)("a cluster dropped on the %s canvas starts on a catalog version", (provider) => {
		expect(K8S_VERSIONS[provider]).toContain(NODE_REGISTRY.cluster.defaultData(provider).cluster_version);
	});

	it("the design page's empty form starts on a catalog version", () => {
		expect(K8S_VERSIONS.aws).toContain(buildDefaultFormValues().cluster.cluster_version);
	});
});
