// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Surface 1's auto-derive, end to end through the canvas store: attaching a chart from a private
// OCI registry should wire up its chart repo without the user selecting anything, and should stay
// quiet (not guess) when the pairing is genuinely ambiguous.

import { useEffect } from "react";
import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import type { ConnectorWithConnection } from "@/app/server/actions/connectors";
import { ConnectorsProvider } from "@/components/design-project/connectors-context";
import { useHelmRegistryReconcile } from "@/components/design-project/canvas/use-helm-registry-reconcile";
import type { UnresolvedChartHost } from "@/lib/connectors/helm-registry-derive";
import { useCanvasStore } from "@/lib/stores/use-canvas-store";

/** A connected chart-repo connector. Only slug/category/connected steer the derivation. */
function chartRepoConnector(
	slug: string,
	over: Partial<ConnectorWithConnection> = {},
): ConnectorWithConnection {
	return {
		id: `c-${slug}`,
		slug,
		name: slug,
		description: "",
		category: "helm_registry",
		auth_method: "api_key",
		organization: "",
		icon_url: "",
		docs_url: null,
		support_url: null,
		privacy_url: null,
		status: "active",
		sort_order: 0,
		created_at: null,
		updated_at: null,
		connected: true,
		connection_details: null,
		group: "chart_repos",
		...over,
	};
}

/** Puts a BYO chart node on the canvas the way setChartNodes does. */
function seedChart(repoUrl: string, id = "payments") {
	useCanvasStore.getState().setChartNodes([
		{
			id,
			repoUrl,
			chartPath: "",
			ref: "*",
			namespace: "default",
			values: {},
			valuesYaml: null,
			status: "PENDING",
			health: null,
			sync: null,
			lastSyncedAt: null,
			scanStatus: "unscanned",
			scanReport: null,
			scannedAt: null,
		},
	]);
}

/** Renders the hook and captures what it could not resolve. */
function renderReconcile(connectors: ConnectorWithConnection[]) {
	const captured: { unresolved: UnresolvedChartHost[] } = { unresolved: [] };
	function Probe() {
		const { unresolved } = useHelmRegistryReconcile();
		// Reported from an effect, not during render — a render-phase write is exactly the pattern the
		// React Compiler lint rejects.
		useEffect(() => {
			captured.unresolved = unresolved;
		}, [unresolved]);
		return null;
	}
	render(
		<ConnectorsProvider connectors={connectors}>
			<Probe />
		</ConnectorsProvider>,
	);
	return captured;
}

/** The chart-repo selections currently on the graph. */
function chartRepoRows() {
	return useCanvasStore
		.getState()
		.nodes.filter((n) => n.data.kind === "helm_registry")
		.map((n) => (n.data.kind === "helm_registry" ? n.data.config : null))
		.filter((v): v is NonNullable<typeof v> => v !== null);
}

describe("useHelmRegistryReconcile", () => {
	beforeEach(() => {
		useCanvasStore.getState().reset();
	});

	it("derives the chart repo for a chart's oci:// host without asking", () => {
		seedChart("oci://ghcr.io/acme/payments");
		const captured = renderReconcile([chartRepoConnector("oci-github-cr")]);

		expect(captured.unresolved).toEqual([]);
		expect(chartRepoRows()).toEqual([
			{ name: "ghcr-io", provider: "oci-github-cr", provider_config: {} },
		]);
	});

	it("stages the derived row so it shows up in Pending Changes rather than appearing silently", () => {
		seedChart("oci://ghcr.io/acme/payments");
		renderReconcile([chartRepoConnector("oci-github-cr")]);
		expect(useCanvasStore.getState().dirty).toBe(true);
	});

	it("adds nothing for a public/git chart", () => {
		seedChart("https://github.com/acme/payments-helm");
		const captured = renderReconcile([chartRepoConnector("oci-github-cr")]);

		expect(chartRepoRows()).toEqual([]);
		expect(captured.unresolved).toEqual([]);
	});

	it("reports a host no connected connector can serve instead of guessing", () => {
		seedChart("oci://ghcr.io/acme/payments");
		const captured = renderReconcile([chartRepoConnector("oci-docker-hub")]);

		expect(chartRepoRows()).toEqual([]);
		expect(captured.unresolved).toEqual([
			{ host: "ghcr.io", reason: "no_connector", candidates: [] },
		]);
	});

	it("refuses to pick between two any-host connectors", () => {
		seedChart("oci://harbor.acme.io/charts/payments");
		const captured = renderReconcile([
			chartRepoConnector("oci-generic-cr"),
			chartRepoConnector("oci-scaleway-cr"),
		]);

		expect(chartRepoRows()).toEqual([]);
		expect(captured.unresolved[0]).toMatchObject({
			host: "harbor.acme.io",
			reason: "ambiguous",
		});
	});

	it("ignores a connector that is catalogued but not connected", () => {
		seedChart("oci://ghcr.io/acme/payments");
		const captured = renderReconcile([
			chartRepoConnector("oci-github-cr", { connected: false }),
		]);

		expect(chartRepoRows()).toEqual([]);
		expect(captured.unresolved[0].reason).toBe("no_connector");
	});

	it("settles instead of re-deriving on every render", () => {
		seedChart("oci://ghcr.io/acme/payments");
		renderReconcile([chartRepoConnector("oci-github-cr")]);
		// A second mount over the same store must not add a duplicate row (the DB uniquely keys
		// (project, environment, name), so a repeat would fail the save).
		renderReconcile([chartRepoConnector("oci-github-cr")]);
		expect(chartRepoRows()).toHaveLength(1);
	});
});
