// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The marketplace Vault's init/unseal bootstrap (#2717).
//
// A freshly installed Vault is SEALED, and hashicorp/vault-helm ships no init hook of any kind. So
// the catalog offers `initialize`, and the resolved install spec carries a `bootstrap` the RUNNER
// turns into a one-shot in-cluster Job. Everything below is a property of that hand-off, and each
// one fails silently if it breaks: a missing bootstrap installs a Vault that never comes up, and a
// bootstrap emitted where it cannot work installs a Job that retries until its backoff is spent.
//
// The Go side pins the same hand-off from the other end (packages/core/argocd/addon_bootstrap_test.go
// reads apiBase back out of the generated fixture). This file pins the DECISION; that one pins the
// STRING.

import { describe, expect, it } from "vitest";
import { getAddOn, resolveAddOnInstall } from "@/lib/addons/catalog";
import { ADDON_BOOTSTRAP_KINDS } from "@/lib/addons/types";

const resolveVault = (values?: Record<string, unknown>) =>
	resolveAddOnInstall({ addon_id: "vault", mode: "managed", values: values ?? null });

describe("the marketplace Vault's init/unseal bootstrap", () => {
	it("is emitted AT CATALOG DEFAULTS — a one-click install must come up", () => {
		const spec = resolveVault();
		expect(spec?.bootstrap).toEqual({
			kind: "vault-init",
			apiBase: "http://addon-vault.vault.svc.cluster.local:8200",
			stateSecret: "alethia-vault-addon-state",
		});
	});

	it("names a kind the runner knows", () => {
		// A free string here would be a bootstrap the runner refuses at deploy time, on a real cloud,
		// after the cluster is already up.
		expect(ADDON_BOOTSTRAP_KINDS).toContain(resolveVault()?.bootstrap?.kind);
	});

	// The knob is the whole point of it being a knob: an operator who wants to hold the unseal key
	// themselves must get a Vault Alethia has not touched.
	it("is withheld when the operator turns `initialize` off", () => {
		expect(resolveVault({ initialize: false })?.bootstrap).toBeUndefined();
	});

	// Raft means three replicas, each of which must be joined and unsealed. This rail unseals ONE
	// node, so emitting it on HA would open a third of a cluster and report success.
	it("is withheld on HA, where unsealing one node is not unsealing the cluster", () => {
		expect(resolveVault({ initialize: true, ha: true })?.bootstrap).toBeUndefined();
	});

	// The DEFAULT is the axis a single-case test would miss: `initialize` could default to false and
	// every assertion above would still pass.
	it("defaults `initialize` on and `injector` off", () => {
		const def = getAddOn("vault");
		const parsed = def?.configSchema.parse({}) as { initialize: boolean; injector: boolean };
		expect(parsed.initialize).toBe(true);
		expect(parsed.injector).toBe(false);
	});

	// The chart's own default is injector: true, and the injector rewrites its own webhook's CA
	// bundle at runtime (its ClusterRole grants `patch` on mutatingwebhookconfigurations). Under an
	// Application with selfHeal that is a permanent fight, not a diff. The emitted value must be
	// EXPLICIT — omitting the key would silently inherit the chart default.
	it("disables the agent injector explicitly, not by omission", () => {
		expect(resolveVault()?.values.injector).toEqual({ enabled: false });
		expect(resolveVault({ injector: true })?.values.injector).toEqual({ enabled: true });
	});

	// The contract that keeps this out of the leak class: `bootstrap` rides the config snapshot,
	// which is persisted in Postgres. Names, namespaces and addresses only.
	it("carries no credential and no path, query or userinfo in its address", () => {
		const bootstrap = resolveVault()?.bootstrap;
		expect(Object.keys(bootstrap ?? {}).sort()).toEqual(["apiBase", "kind", "stateSecret"]);
		expect(bootstrap?.apiBase).toMatch(/^https?:\/\/[a-z0-9][a-z0-9.-]*(:\d+)?$/);
	});

	// Every OTHER add-on must stay bootstrap-free, or the runner would apply Jobs nobody asked for.
	it("is the only add-on that asks for one", () => {
		const withBootstrap = ["vault", "velero", "harbor", "minio", "loki", "kyverno"]
			.map((id) => ({ id, spec: resolveAddOnInstall({ addon_id: id, mode: "managed" }) }))
			.filter(({ spec }) => spec?.bootstrap)
			.map(({ id }) => id);
		expect(withBootstrap).toEqual(["vault"]);
	});
});
