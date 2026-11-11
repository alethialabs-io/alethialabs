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

	it("does NOT serve NGINX-class Ingresses by default — an unsupported annotation is dropped silently", () => {
		// Turned on beside a running ingress-nginx, the provider would serve every nginx-class route on
		// a second address without the controls it cannot read. The guide's review comes first.
		expect(resolved()).toMatchObject({
			providers: { kubernetesIngressNGINX: { enabled: false, publishService: { enabled: true } } },
		});
		expect(resolved({ ingressNginx: true })).toMatchObject({
			providers: { kubernetesIngressNGINX: { enabled: true } },
		});
	});

	it("refuses ExternalName backends", () => {
		expect(resolved()).toMatchObject({
			providers: { kubernetesIngressNGINX: { disableSvcExternalName: true } },
		});
	});

	it("configures no Traefik API at all: `api` resolves to null, which removes the chart's defaults", () => {
		// `{ dashboard: false }` would still render `--api.*` arguments, and any of them enables the API.
		const v = resolved();
		expect(v).toHaveProperty("api");
		expect(v.api).toBeNull();
		// The null must reach the fixture the chart checks render, not only the in-memory spec.
		expect(JSON.stringify(v)).toContain('"api":null');
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
		const v = resolved({ replicas: 3, serviceType: "NodePort", metrics: true, ingressNginx: true });
		expect(v).toMatchObject({
			deployment: { replicas: 3 },
			service: { spec: { type: "NodePort" } },
			metrics: { prometheus: { service: { enabled: true } } },
			providers: { kubernetesIngressNGINX: { enabled: true } },
		});
	});
});
