// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The deploy form's identity source. It used to be the UNFILTERED list, so a user whose only
// verified cloud was GCP could pick it — and CloudIdentitySelector auto-selects a lone identity,
// so the unbuildable choice arrived pre-filled. These pin that the form asks only for the clouds
// we hold runner templates for, and that a user with none of them reads a truthful boundary
// instead of a form whose job dies later in the runner log.

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/server/actions/aws/identities", () => ({
	getVerifiedCloudIdentities: vi.fn(async () => []),
	getVerifiedCloudIdentitiesByProvider: vi.fn(async () => []),
}));
vi.mock("@/app/server/actions/runners", () => ({ registerRunner: vi.fn() }));
vi.mock("@/lib/query/use-runners-query", () => ({
	useRunnersQuery: () => ({ data: { runners: [] } }),
	useDeployRunner: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock("@/lib/stores/use-cloud-provider-store", () => ({
	useCloudProviderStore: () => ({
		provider: "aws",
		cachedResources: null,
		setIdentity: vi.fn(),
		isLoading: false,
	}),
}));
vi.mock("@/lib/stores/use-workspace-store", () => ({
	useActiveOrgSlug: () => "acme",
}));
vi.mock("next/navigation", () => ({
	useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
	useParams: () => ({}),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { AddRunnerDialog } from "@/components/runners/add-runner-dialog";
import {
	getVerifiedCloudIdentities,
	getVerifiedCloudIdentitiesByProvider,
} from "@/app/server/actions/aws/identities";

beforeEach(() => vi.clearAllMocks());

describe("AddRunnerDialog — deploy path", () => {
	it("asks only for the clouds a runner can be deployed into", async () => {
		render(<AddRunnerDialog open onOpenChange={() => {}} />);
		await waitFor(() =>
			expect(getVerifiedCloudIdentitiesByProvider).toHaveBeenCalledWith("aws"),
		);
		// The unfiltered list is what offered gcp/azure/alibaba in the first place.
		expect(getVerifiedCloudIdentities).not.toHaveBeenCalled();
	});

	it("tells a user with no deployable cloud the truth, not 'connect AWS, GCP, or Azure'", async () => {
		const user = userEvent.setup();
		render(<AddRunnerDialog open onOpenChange={() => {}} />);
		await user.click(screen.getByRole("button", { name: /deploy to a cloud/i }));

		expect(
			await screen.findByRole("heading", { name: /no aws account connected/i }),
		).toBeInTheDocument();
		expect(document.body.textContent).toMatch(/deployed runners are AWS only/i);
		expect(document.body.textContent).not.toMatch(/Connect AWS, GCP, or Azure/i);
	});
});
