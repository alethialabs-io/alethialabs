// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The canvas "Add" palette surfaces an "Add-ons" group (edit mode only). Add-ons are browsed here
// and open a config sheet rather than dropping a graph node — so the group is present only when the
// caller passes addonItems + onConfigureAddon, and selecting one calls onConfigureAddon with it.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AddonMarketItem } from "@/app/server/actions/addons";
import { NodePalette } from "@/components/design-project/canvas/node-palette";
import { useCanvasStore } from "@/lib/stores/use-canvas-store";

const ITEMS: AddonMarketItem[] = [
	{
		id: "loki",
		name: "Grafana Loki",
		category: "observability",
		icon: "ScrollText",
		summary: "Log aggregation",
		docsUrl: "https://example.com",
		license: "AGPL-3.0",
		chart: "loki",
		version: "1.0.0",
		namespace: "logging",
		requires: [],
		fields: [],
		install: null,
	},
	{
		id: "vault",
		name: "HashiCorp Vault",
		category: "secrets",
		icon: "KeyRound",
		summary: "Secrets management",
		docsUrl: "https://example.com",
		license: "BUSL-1.1",
		chart: "vault",
		version: "1.0.0",
		namespace: "vault",
		requires: [],
		fields: [],
		install: {
			enabled: true,
			mode: "managed",
			values: {},
			valuesYaml: null,
			status: "PENDING",
			health: null,
			sync: null,
			lastSyncedAt: null,
		},
	},
];

beforeEach(() => {
	// A clean graph so the service groups' "on canvas" checks are deterministic.
	useCanvasStore.setState({ nodes: [] });
});

describe("NodePalette — Add-ons group", () => {
	it("renders the add-ons and invokes onConfigureAddon on select", async () => {
		const onConfigureAddon = vi.fn();
		render(
			<NodePalette
				open
				onOpenChange={vi.fn()}
				identities={[]}
				addonItems={ITEMS}
				onConfigureAddon={onConfigureAddon}
			/>,
		);

		expect(screen.getByText("Add-ons")).toBeInTheDocument();
		expect(screen.getByText("Grafana Loki")).toBeInTheDocument();
		expect(screen.getByText("HashiCorp Vault")).toBeInTheDocument();

		await userEvent.click(screen.getByText("Grafana Loki"));
		expect(onConfigureAddon).toHaveBeenCalledWith(ITEMS[0]);
	});

	it("omits the Add-ons group in the create flow (no items / no handler)", () => {
		render(
			<NodePalette open onOpenChange={vi.fn()} identities={[]} />,
		);
		expect(screen.queryByText("Add-ons")).not.toBeInTheDocument();
		// The service palette itself still renders.
		expect(screen.getByText("Database")).toBeInTheDocument();
	});
});
