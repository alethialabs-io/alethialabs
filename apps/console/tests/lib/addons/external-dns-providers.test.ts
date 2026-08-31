// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// OFFER PARITY for the ExternalDNS add-on: every provider the catalog OFFERS must have a credential
// path that could actually work.
//
// The catalog offered six and wired two. The mapping was one line —
// `c.provider === "digitalocean" ? "DO_TOKEN" : "CF_API_TOKEN"` — so hetzner, aws, google and azure
// each received a Cloudflare-shaped env var, and there was no service-account knob at all, which put
// IRSA and Workload Identity out of reach. Four of six offers could not be honoured.
//
// WHAT MAKES THIS TESTABLE AT ALL. An add-on that starts and then fails every write reports
// `Degraded` in exactly the way an unconfigured one does, so the symptom cannot distinguish "the
// user has not configured it" from "we sent it a credential it has no use for". These tests read the
// RENDERED VALUES instead of the health, because the values are where the two differ.
//
// The sweep at the end is the load-bearing part: it is driven by the offered enum rather than a
// hand-written list, so ADDING a provider to the offer without a credential path fails here.

import { describe, expect, it } from "vitest";
import { getAddOn, resolveAddOnInstall } from "@/lib/addons/catalog";

const externalDns = getAddOn("external-dns");
if (!externalDns) throw new Error("the external-dns catalog entry is missing");

/** Every provider id the console actually offers, read off the field descriptor the UI renders. */
const OFFERED = (externalDns.fields.find((f) => f.key === "provider")?.options ?? []).map((o) => o.value);

/** Resolve the add-on's Helm values for one configuration.
 *
 * A non-empty `apiToken` in the stored values IS a stored secret as far as `hasStoredSecret` is
 * concerned, so passing one is what activates the `secretValues` path — the same route a real
 * encrypted envelope takes. */
function values(config: Record<string, unknown>) {
	const resolved = resolveAddOnInstall({ addon_id: "external-dns", mode: "managed", values: config });
	if (!resolved) throw new Error("external-dns did not resolve");
	return resolved.values as Record<string, unknown>;
}

/** Walk a rendered values object and collect every `name` under any `env:` array, at any depth. */
function envNames(v: unknown): string[] {
	const found: string[] = [];
	const walk = (node: unknown) => {
		if (Array.isArray(node)) return node.forEach(walk);
		if (!node || typeof node !== "object") return;
		for (const [k, child] of Object.entries(node)) {
			if (k === "env" && Array.isArray(child)) {
				for (const e of child) if (e && typeof e === "object" && "name" in e) found.push(String(e.name));
			}
			walk(child);
		}
	};
	walk(v);
	return found;
}

describe("ExternalDNS offers exactly the providers it can authenticate", () => {
	it("offers six providers", () => {
		expect(OFFERED).toEqual(["cloudflare", "digitalocean", "hetzner", "aws", "google", "azure"]);
	});

	// THE SWEEP. Every offered provider, driven from the offer itself — so adding a seventh without
	// a credential path fails here rather than in a customer's cluster.
	it.each(OFFERED)("%s renders a credential path that could work", (provider) => {
		const withToken = values({ provider, apiToken: "t" });
		const withIdentity = values({ provider, workloadIdentity: "id-for-this-cloud" });

		const tokenEnvs = envNames(withToken);
		const sa = (withIdentity as Record<string, { annotations?: Record<string, string> }>).serviceAccount;
		const annotations = Object.keys(sa?.annotations ?? {});

		// Exactly one of the two shapes, never both and never neither. "Neither" is the bug this
		// file was written for; "both" would mean we ask a user for a credential they do not need.
		expect(
			tokenEnvs.length > 0 !== annotations.length > 0,
			`${provider}: token envs ${JSON.stringify(tokenEnvs)}, SA annotations ${JSON.stringify(annotations)}`,
		).toBe(true);
	});

	it("never sends a Cloudflare env var to a provider that is not Cloudflare", () => {
		for (const provider of OFFERED) {
			if (provider === "cloudflare") continue;
			expect(envNames(values({ provider, apiToken: "t" })), `${provider} got CF_API_TOKEN`).not.toContain(
				"CF_API_TOKEN",
			);
		}
	});
});

describe("the token providers", () => {
	it.each([
		["cloudflare", "CF_API_TOKEN"],
		["digitalocean", "DO_TOKEN"],
		["hetzner", "HETZNER_TOKEN"],
	])("%s delivers its token as %s", (provider, env) => {
		expect(envNames(values({ provider, apiToken: "t" }))).toContain(env);
	});

	it("renders no env at all when no token is stored — an empty credential must not look configured", () => {
		expect(envNames(values({ provider: "cloudflare" }))).toEqual([]);
	});
});

describe("hetzner goes through the webhook sidecar, not a native provider", () => {
	// ExternalDNS ships NO native `hetzner` provider, so `provider.name: "hetzner"` — what the old
	// wiring produced — is not a configuration the chart understands. This is the assertion that
	// pins the difference between an offer that renders and an offer that runs.
	it("never names hetzner as the provider", () => {
		const v = values({ provider: "hetzner", apiToken: "t" }) as { provider: { name: string } };
		expect(v.provider.name).toBe("webhook");
	});

	it("puts the token in the SIDECAR's env, not the controller's", () => {
		const v = values({ provider: "hetzner", apiToken: "t" }) as {
			env?: unknown[];
			provider: { webhook: { env: { name: string }[]; image: { repository: string; tag: string } } };
		};
		expect(v.provider.webhook.env.map((e) => e.name)).toEqual(["HETZNER_TOKEN"]);
		expect(v.env, "the controller must not also carry the token").toBeUndefined();
		expect(v.provider.webhook.image.repository).toContain("external-dns-hetzner-webhook");
	});
});

describe("the workload-identity providers", () => {
	it.each([
		["aws", "eks.amazonaws.com/role-arn"],
		["google", "iam.gke.io/gcp-service-account"],
		["azure", "azure.workload.identity/client-id"],
	])("%s annotates its ServiceAccount with %s", (provider, annotation) => {
		const v = values({ provider, workloadIdentity: "the-identity" }) as {
			serviceAccount: { name: string; annotations: Record<string, string> };
		};
		expect(v.serviceAccount.annotations[annotation]).toBe("the-identity");
		expect(v.serviceAccount.name).toBe("addon-external-dns");
	});

	// A token on a keyless provider is not merely useless — it invites a user to paste a long-lived
	// key where none is needed, which is the opposite of what this product claims about credentials.
	it.each(["aws", "google", "azure"])("%s takes NO token even when one is stored", (provider) => {
		expect(envNames(values({ provider, apiToken: "t", workloadIdentity: "id" }))).toEqual([]);
	});

	it("azure also labels its pods, or the identity webhook never injects", () => {
		const v = values({ provider: "azure", workloadIdentity: "client-id" }) as {
			podLabels?: Record<string, string>;
		};
		expect(v.podLabels?.["azure.workload.identity/use"]).toBe("true");
	});

	it("renders no ServiceAccount when no identity is supplied — a half-configured install must not look whole", () => {
		const v = values({ provider: "aws" }) as { serviceAccount?: unknown };
		expect(v.serviceAccount).toBeUndefined();
	});
});

describe("the knobs that were already right stay right", () => {
	it("passes a domain filter through", () => {
		const v = values({ provider: "cloudflare", domainFilter: "example.com" }) as { domainFilters: string[] };
		expect(v.domainFilters).toEqual(["example.com"]);
	});

	it("omits domainFilters entirely when the filter is empty, rather than sending an empty list", () => {
		expect(values({ provider: "cloudflare" })).not.toHaveProperty("domainFilters");
	});
});
