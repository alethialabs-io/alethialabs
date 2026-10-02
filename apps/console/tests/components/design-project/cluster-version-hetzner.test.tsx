// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The cluster card's Kubernetes version on Hetzner (#5366). Hetzner installs one version, pinned by
// its Talos release, and never reads `cluster_version`, so the field is read-only there and names
// the pin. A row that already holds another minor is refused by the next apply, so for that row the
// select stays open with the pinned minor as the way out.

import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigFields } from "@/components/design-project/canvas/inspector/config-fields";
import {
	getKindConfig,
	NO_CAPABILITIES,
	type KindConfig,
} from "@/components/design-project/canvas/inspector/config-schema";
import type { CloudProviderSlug } from "@/lib/cloud-providers";
import {
	HETZNER_K8S_MINOR,
	HETZNER_K8S_VERSION,
} from "@/lib/cloud-providers/hetzner-k8s-pin";
import { useInspectorPrefsStore } from "@/lib/stores/use-inspector-prefs-store";

const cluster = getKindConfig("cluster") as KindConfig;
const versionField = cluster.sections
	.flatMap((s) => s.fields)
	.find((f) => f.key === "cluster_version");

function renderCluster(config: Record<string, unknown>, provider: CloudProviderSlug) {
	render(
		<ConfigFields schema={cluster} config={config} provider={provider} onChange={vi.fn()} />,
	);
}

/** The version field's row: its label's wrapper, which also holds the control and its notes. */
function versionRow(): HTMLElement {
	const row = screen.getByText("Kubernetes version").parentElement;
	if (!row) throw new Error("Kubernetes version label has no row");
	return row;
}

/** The field context the schema's closures read. */
function ctx(config: Record<string, unknown>, provider: CloudProviderSlug) {
	return { provider, config, caps: NO_CAPABILITIES };
}

beforeEach(() => {
	useInspectorPrefsStore.setState({ openSections: {}, tab: {} });
});
afterEach(cleanup);

describe("Kubernetes version on Hetzner", () => {
	it("is read-only and names the pin when unset", () => {
		renderCluster({}, "hetzner");
		expect(
			screen.getByText(`Hetzner installs Kubernetes ${HETZNER_K8S_VERSION}, pinned by its Talos release. It cannot be changed here.`),
		).toBeInTheDocument();
		expect(screen.queryByLabelText("Kubernetes version")).toBeNull();
		// No list is shown, so nothing says where a list came from.
		expect(within(versionRow()).queryByText("Showing the full catalog.")).toBeNull();
	});

	it("is read-only when it holds the pinned minor", () => {
		renderCluster({ cluster_version: HETZNER_K8S_MINOR }, "hetzner");
		expect(screen.getByText(/It cannot be changed here\./)).toBeInTheDocument();
		expect(screen.queryByLabelText("Kubernetes version")).toBeNull();
	});

	it("stays a select on every other cloud", () => {
		renderCluster({ cluster_version: "1.33" }, "aws");
		expect(screen.queryByText(/pinned by its Talos release/)).toBeNull();
		expect(screen.getByLabelText("Kubernetes version")).toBeInTheDocument();
		expect(within(versionRow()).getByText("Showing the full catalog.")).toBeInTheDocument();
	});

	it("opens, offering the pin, for a row that holds another minor", () => {
		const c = { cluster_version: "1.33" };
		expect(versionField?.unavailableWhen?.(c, ctx(c, "hetzner"))).toBeNull();
		renderCluster(c, "hetzner");
		expect(screen.getByLabelText("Kubernetes version")).toBeInTheDocument();

		const options = typeof versionField?.options === "function"
			? versionField.options(ctx(c, "hetzner"))
			: [];
		expect(options.map((o) => o.value)).toEqual([HETZNER_K8S_MINOR, "1.33"]);
		expect(options[1]?.advisory?.level).toBe("unavailable");
		expect(options[1]?.advisory?.note).toContain(HETZNER_K8S_VERSION);
	});

	it("offers only the pinned minor otherwise", () => {
		const c = {};
		const options = typeof versionField?.options === "function"
			? versionField.options(ctx(c, "hetzner"))
			: [];
		expect(options).toEqual([
			{ value: HETZNER_K8S_MINOR, label: `${HETZNER_K8S_MINOR} (installs ${HETZNER_K8S_VERSION})` },
		]);
	});

	it("summarises the card with the installed version", () => {
		expect(cluster.summary({ cluster_version: "1.33", node_min_size: 1, node_max_size: 2 }, "hetzner")).toBe(
			`k8s ${HETZNER_K8S_VERSION} · 1–2 nodes`,
		);
		expect(cluster.summary({ cluster_version: "1.33", node_min_size: 1, node_max_size: 2 }, "aws")).toBe(
			"k8s 1.33 · 1–2 nodes",
		);
	});
});
