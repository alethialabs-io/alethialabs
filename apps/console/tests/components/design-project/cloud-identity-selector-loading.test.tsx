// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The cloud-identity picker's fetching state (#7873): while the selected identity's inventory is
// read, the picker shows the inline `[·]` MarkLoader beside its line, not a spinning icon. The
// store is mocked so the test drives the loading flag directly.

import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudProviderResources } from "@/lib/stores/use-cloud-provider-store";
import { CloudIdentitySelector } from "@/components/design-project/cloud-identity-selector";

const { resources } = vi.hoisted(() => ({
	resources: { isLoading: false },
}));

vi.mock("@/lib/stores/use-cloud-provider-store", () => ({
	useCloudProviderStore: (select: (s: { setIdentity: () => void }) => unknown) =>
		select({ setIdentity: () => undefined }),
	useCloudProviderResources: (): CloudProviderResources => ({
		provider: "aws",
		identityId: "id-1",
		cachedResources: null,
		isLoading: resources.isLoading,
		error: null,
	}),
}));

const IDENTITIES = [
	{ id: "id-1", name: "prod", displayId: "123456789012", provider: "aws" },
	{ id: "id-2", name: "staging", displayId: "210987654321", provider: "aws" },
];

describe("CloudIdentitySelector fetching state", () => {
	beforeEach(() => {
		resources.isLoading = false;
	});

	it("shows the inline mark loader, not a spinner, while resources load", () => {
		resources.isLoading = true;
		const { container } = render(
			<CloudIdentitySelector identities={IDENTITIES} value="id-1" onChange={vi.fn()} />,
		);
		const loader = screen.getByRole("status");
		expect(loader).toHaveAttribute("data-slot", "mark-loader");
		expect(loader).toHaveAttribute("data-size", "inline");
		expect(loader).toHaveTextContent("Loading resources");
		expect(container.querySelector(".animate-spin")).toBeNull();
	});

	it("shows no loader once the resources are in", () => {
		render(<CloudIdentitySelector identities={IDENTITIES} value="id-1" onChange={vi.fn()} />);
		expect(screen.queryByRole("status")).not.toBeInTheDocument();
	});
});
