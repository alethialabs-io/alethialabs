// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6543: the Traefik add-on, ingress-nginx's replacement. Its defaults are decisions, not chart
// defaults, and each is pinned here with its reason (docs/adr/0006-ingress-nginx-replacement.md).

import { describe, expect, it } from "vitest";
import { getAddOn, resolveAddOnInstall } from "@/lib/addons/catalog";

const traefik = getAddOn("traefik");

/** The resolved install values for a managed Traefik with `values` as its knobs. */
function resolved(values: Record<string, unknown> = {}) {
	const spec = resolveAddOnInstall({ addon_id: "traefik", mode: "managed", values });
	if (!spec) throw new Error("traefik is not in the catalogue");
	return spec.values;
}

describe("the Traefik add-on", () => {
	it("is a classic-repo chart pinned to an exact version", () => {
		expect(traefik?.chartRepo).toBe("https://traefik.github.io/charts");
		expect(traefik?.chart).toBe("traefik");
		expect(traefik?.version).toMatch(/^\d+\.\d+\.\d+$/);
		expect(traefik?.deprecated).toBeUndefined();
	});

	it("serves NGINX-class Ingresses by default, and publishes the LB address into their status", () => {
		const v = resolved();
		expect(v).toMatchObject({
			providers: {
				kubernetesIngressNGINX: { enabled: true, publishService: { enabled: true } },
			},
		});
	});

	it("keeps Gateway API OFF by default — the clusters carry no Gateway API CRDs", () => {
		expect(resolved()).toMatchObject({ providers: { kubernetesGateway: { enabled: false } } });
		expect(resolved({ gatewayApi: true })).toMatchObject({
			providers: { kubernetesGateway: { enabled: true } },
		});
	});

	it("never makes its IngressClass the cluster default", () => {
		expect(resolved()).toMatchObject({ ingressClass: { enabled: true, isDefaultClass: false } });
	});

	it("requests resources, so the proxy is not BestEffort", () => {
		expect(resolved()).toMatchObject({
			resources: { requests: { cpu: "100m", memory: "128Mi" }, limits: { memory: "512Mi" } },
		});
	});

	it("maps the knobs onto the chart's own keys", () => {
		const v = resolved({ replicas: 3, serviceType: "NodePort", metrics: true, ingressNginx: false });
		expect(v).toMatchObject({
			deployment: { replicas: 3 },
			service: { spec: { type: "NodePort" } },
			metrics: { prometheus: { service: { enabled: true } } },
			providers: { kubernetesIngressNGINX: { enabled: false } },
		});
	});
});
