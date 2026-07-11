// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The add-on config sheet's Requirements block: renders one provider-aware hint row per
// declared requirement (badge label + hint text), and renders nothing for add-ons with no
// requirements. The enable/disable mutation hooks are mocked.

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AddonMarketItem } from "@/app/server/actions/addons";

const { enableMut, disableMut } = vi.hoisted(() => ({
	enableMut: { mutateAsync: vi.fn(), isPending: false },
	disableMut: { mutateAsync: vi.fn(), isPending: false },
}));
vi.mock("@/lib/query/use-addons-query", () => ({
	useEnableAddon: () => enableMut,
	useDisableAddon: () => disableMut,
	useAddonsQuery: vi.fn(),
}));

import { AddonConfigSheet } from "@/components/addons/addon-config-sheet";

/** A minimal marketplace item; `requires` varies per test. */
function makeItem(requires: AddonMarketItem["requires"]): AddonMarketItem {
	return {
		id: "harbor",
		name: "Harbor",
		category: "platform",
		icon: "Boxes",
		summary: "OCI registry.",
		docsUrl: "https://example.com",
		license: "Apache-2.0",
		chart: "harbor",
		version: "1.0.0",
		namespace: "harbor",
		requires,
		fields: [],
		install: null,
	};
}

describe("AddonConfigSheet requirements", () => {
	it("renders provider-aware hints for storage + ingress on hetzner", () => {
		render(
			<AddonConfigSheet
				item={makeItem(["storage", "ingress"])}
				projectId="p1"
				environmentId="e1"
				hasAppsRepo={false}
				provider="hetzner"
				open
				onOpenChange={vi.fn()}
			/>,
		);
		expect(screen.getByText("Requirements")).toBeInTheDocument();
		// Badge labels.
		expect(screen.getByText("Storage")).toBeInTheDocument();
		expect(screen.getByText("Ingress")).toBeInTheDocument();
		// Hetzner ground truth: the in-template default StorageClass + the CCM/ingress hint.
		expect(screen.getByText(/hcloud-volumes/)).toBeInTheDocument();
		expect(
			screen.getByText(/hcloud load balancers via the in-cluster CCM/i),
		).toBeInTheDocument();
	});

	it("renders no Requirements block for an add-on without requirements", () => {
		render(
			<AddonConfigSheet
				item={makeItem([])}
				projectId="p1"
				environmentId="e1"
				hasAppsRepo={false}
				provider="hetzner"
				open
				onOpenChange={vi.fn()}
			/>,
		);
		expect(screen.queryByText("Requirements")).not.toBeInTheDocument();
	});
});
