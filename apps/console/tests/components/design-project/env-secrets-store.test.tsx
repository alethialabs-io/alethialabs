// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The environment's secret-store picker (#1412).
//
// One environment reads through ONE store — `dominantProvider` picks the first pluggable row's slug
// and applies it to every secret — so the control is per environment and must write its choice to
// EVERY secret row. Leaving rows behind would make the database say two things while the deploy
// silently picks one, which is the ambiguity this control exists to remove.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EnvSettingsSheet } from "@/components/design-project/canvas/env-settings-sheet";
import { NODE_REGISTRY } from "@/components/design-project/canvas/graph/node-registry";
import { PROJECT_NODE_ID, useCanvasStore } from "@/lib/stores/use-canvas-store";
import type { CanvasNode } from "@/components/design-project/canvas/graph/types";
import type { ConnectorProviderMeta } from "@/lib/connectors/registry.generated";

vi.mock("next/navigation", () => ({ useParams: () => ({ org: "acme" }) }));

const VAULT: ConnectorProviderMeta = {
	category: "secrets",
	slug: "vault",
	name: "HashiCorp Vault",
	description: "",
	organization: "",
	icon_url: "",
	status: "active",
	sort_order: 1,
	modulePath: "",
	credentialFields: [],
	providerConfigFields: [
		{ key: "mount_path", label: "Mount path", type: "text", required: true },
	],
};
// Connectable, but no in-cluster read path on the pinned ESO chart.
const INFISICAL: ConnectorProviderMeta = { ...VAULT, slug: "infisical", name: "Infisical" };

vi.mock("@/components/design-project/connectors-context", () => ({
	useConnectedProviders: () => [VAULT, INFISICAL],
}));

vi.mock("@/lib/connectors/registry.generated", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@/lib/connectors/registry.generated")>();
	return {
		...actual,
		getConnectorProviderBySlug: (slug: string) =>
			[VAULT, INFISICAL].find((p) => p.slug === slug),
	};
});

function seed(secretNames: string[], config: Record<string, unknown> = {}) {
	const root = {
		id: PROJECT_NODE_ID,
		type: "project",
		position: { x: 0, y: 0 },
		data: {
			kind: "project",
			config: NODE_REGISTRY.project.defaultData("aws"),
			cloud_identity_id: null,
			provider: "aws",
		},
	} as CanvasNode;
	const secrets = secretNames.map(
		(name) =>
			({
				id: `secret-${name}`,
				type: "secret",
				position: { x: 0, y: 0 },
				data: {
					kind: "secret",
					config: { ...NODE_REGISTRY.secret.defaultData("aws"), name, ...config },
					cloud_identity_id: null,
					provider: "aws",
				},
			}) as CanvasNode,
	);
	useCanvasStore.setState({
		nodes: [root, ...secrets],
		identities: [],
		baseline: [],
		collectionPositions: {},
		envSettingsOpen: true,
	});
	return secrets;
}

/** Each secret node's stored provider, in seed order. */
const providers = () =>
	useCanvasStore
		.getState()
		.nodes.filter((n) => n.data.kind === "secret")
		.map((n) => (n.data.config as { provider?: unknown }).provider);

describe("environment secret store", () => {
	beforeEach(() => {
		useCanvasStore.setState({ envSettingsOpen: false });
	});

	it("writes the chosen store to EVERY secret in the environment", async () => {
		seed(["api-key", "stripe-key", "sendgrid-key"]);
		const user = userEvent.setup();
		render(<EnvSettingsSheet />);

		await user.click(screen.getByRole("combobox", { name: /secret/i }));
		await user.click(await screen.findByRole("option", { name: /vault/i }));

		// All three, not just the first — the deploy reads one store for the whole environment.
		expect(providers()).toEqual(["vault", "vault", "vault"]);
	});

	it("reverts every secret to the cluster's native store", async () => {
		seed(["api-key", "stripe-key"], {
			provider: "vault",
			provider_config: { mount_path: "secret" },
		});
		const user = userEvent.setup();
		render(<EnvSettingsSheet />);

		await user.click(screen.getByRole("combobox", { name: /secret/i }));
		await user.click(await screen.findByRole("option", { name: /cluster native/i }));

		// NULL is the column's sentinel for "no connector" — never a "native" string.
		expect(providers()).toEqual([null, null]);
	});

	it("offers no store to configure when the environment has no secrets", () => {
		seed([]);
		render(<EnvSettingsSheet />);
		expect(screen.getByText(/add a secret to choose where/i)).toBeInTheDocument();
		expect(screen.queryByRole("combobox", { name: /secret/i })).not.toBeInTheDocument();
	});

	it("won't let a store with no in-cluster read be chosen", async () => {
		seed(["api-key"]);
		const user = userEvent.setup();
		render(<EnvSettingsSheet />);

		await user.click(screen.getByRole("combobox", { name: /secret/i }));
		const options = await screen.findAllByRole("option");
		const infisical = options.find((o) => o.textContent?.includes("Infisical"));
		// Shown with the reason rather than hidden: selecting it would switch the native store off
		// project-wide and leave nothing to read from.
		expect(infisical).toHaveAttribute("aria-disabled", "true");
		expect(infisical?.textContent).toMatch(/no in-cluster read yet/i);
	});
});
