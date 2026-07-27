// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The environment's secret store — the reading both the picker (env settings) and the readout
// (Secrets panel) share, plus the guard on stores that can't actually serve a cluster.

import { describe, expect, it } from "vitest";
import {
	NATIVE_LABELS,
	connectorLabel,
	environmentConnector,
	registryUnavailable,
	secretsStoreUnavailable,
} from "@/lib/canvas/environment-connector";
import type { CanvasNode } from "@/components/design-project/canvas/graph/types";

/** A minimal secret node — only `kind` and `config` are read. */
function secretNode(id: string, config: Record<string, unknown>): CanvasNode {
	return {
		id,
		type: "resource",
		position: { x: 0, y: 0 },
		data: { kind: "secret", config },
	} as unknown as CanvasNode;
}

describe("environmentConnector", () => {
	it("reports the native store when no secret names a provider", () => {
		const store = environmentConnector([
			secretNode("a", { name: "api-key" }),
			secretNode("b", { name: "other", provider: "native" }),
		], "secret");
		expect(store.provider).toBeNull();
		expect(store.providerConfig).toEqual({});
		expect(store.count).toBe(2);
	});

	it("reads the selected store and its knobs", () => {
		const store = environmentConnector([
			secretNode("a", {
				name: "api-key",
				provider: "vault",
				provider_config: { mount_path: "secret" },
			}),
		], "secret");
		expect(store.provider).toBe("vault");
		expect(store.providerConfig).toEqual({ mount_path: "secret" });
	});

	// The picker writes through to every row, so they agree — but a project configured before this
	// control existed, or through the CLI (which can set `provider` but not `provider_config`), may
	// not. Resolve it the way the RUNTIME does (first pluggable row wins), or the console would show
	// one store while the deploy used another.
	it("resolves a disagreeing environment the way the deploy will — first pluggable row wins", () => {
		const store = environmentConnector([
			secretNode("a", { name: "native-one" }),
			secretNode("b", { name: "vaulted", provider: "vault", provider_config: { mount_path: "kv" } }),
			secretNode("c", { name: "dopplered", provider: "doppler" }),
		], "secret");
		expect(store.provider).toBe("vault");
		expect(store.providerConfig).toEqual({ mount_path: "kv" });
	});

	it("ignores a malformed provider_config rather than passing it on", () => {
		const store = environmentConnector([
			secretNode("a", { name: "x", provider: "vault", provider_config: "not-an-object" }),
		], "secret");
		expect(store.provider).toBe("vault");
		expect(store.providerConfig).toEqual({});
	});

	it("counts an empty environment as having no store to configure", () => {
		expect(environmentConnector([], "secret")).toEqual({
			provider: null,
			providerConfig: {},
			count: 0,
		});
	});
});

describe("secretsStoreUnavailable", () => {
	// Both are `status: active` and connectable, but neither has an in-cluster read path on the
	// pinned ESO chart. Selecting one is WORSE than doing nothing: it turns the native store off
	// project-wide while providing nothing to read from. The picker must not let one be chosen.
	it.each(["infisical", "onepassword"])("blocks %s, which has no in-cluster read", (slug) => {
		expect(secretsStoreUnavailable(slug)).toBeTruthy();
	});

	it.each(["vault", "doppler", "generic", "aws-sm-xacct"])("allows %s", (slug) => {
		expect(secretsStoreUnavailable(slug)).toBeNull();
	});
});

describe("connectorLabel", () => {
	it("names the native store for null and the 'native' sentinel alike", () => {
		expect(connectorLabel(null, NATIVE_LABELS.secret)).toBe(NATIVE_LABELS.secret);
		expect(connectorLabel("native", NATIVE_LABELS.secret)).toBe(NATIVE_LABELS.secret);
	});

	it("uses the connector's own name", () => {
		expect(connectorLabel("vault", NATIVE_LABELS.secret)).toBe("HashiCorp Vault");
	});

	// A slug the catalog no longer has must still render as itself — falling back to the native
	// label would tell the user their secrets come from somewhere they don't.
	it("falls back to the slug for an unknown provider", () => {
		expect(connectorLabel("retired-store", NATIVE_LABELS.secret)).toBe("retired-store");
	});
});
