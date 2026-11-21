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
const reg = vi.hoisted(() => ({
	mutateAsync: vi.fn(),
	onValidationError: undefined as undefined | ((fields: Record<string, string[] | undefined>) => void),
	refresh: vi.fn(),
	runners: [] as { id: string; name: string; status: string; is_default: boolean; operator: string }[],
}));
vi.mock("@/lib/query/use-runners-query", () => ({
	useRunnersQuery: () => ({ data: { runners: reg.runners }, isPending: false, isError: false, refetch: vi.fn() }),
	useDeployRunner: () => ({ mutate: vi.fn(), isPending: false }),
	useRegisterRunner: (onValidationError: (fields: Record<string, string[] | undefined>) => void) => {
		reg.onValidationError = onValidationError;
		return { mutateAsync: reg.mutateAsync, isPending: false };
	},
}));
vi.mock("@/lib/stores/use-cloud-provider-store", () => {
	// The selection is a Zustand store read through a selector; the inventory is its query hook.
	const store = { provider: "aws", identityId: null, setIdentity: vi.fn() };
	return {
		useCloudProviderStore: (select: (s: typeof store) => unknown) => select(store),
		useCloudProviderResources: () => ({
			provider: "aws",
			identityId: null,
			cachedResources: null,
			isLoading: false,
			error: null,
		}),
	};
});
vi.mock("@/lib/stores/use-workspace-store", () => ({
	useActiveOrgSlug: () => "acme",
}));
vi.mock("next/navigation", () => ({
	useRouter: () => ({ push: vi.fn(), refresh: reg.refresh }),
	useParams: () => ({}),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { AddRunnerDialog } from "@/components/runners/add-runner-dialog";
import {
	getVerifiedCloudIdentities,
	getVerifiedCloudIdentitiesByProvider,
} from "@/app/server/actions/aws/identities";

beforeEach(() => {
	vi.clearAllMocks();
	reg.runners = [];
	// `clearAllMocks` keeps an implementation a test installed; every test starts from "none connected".
	vi.mocked(getVerifiedCloudIdentitiesByProvider).mockImplementation(async () => []);
});

/** One verified AWS account, as the deploy path's read returns it. */
const AWS_ACCOUNT = { id: "id-aws", name: "prod", displayId: "123456789012", provider: "aws" };

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

describe("AddRunnerDialog — register path (#6123: useActionMutation)", () => {
	it("shows the one-time credentials on success, with no page refresh (the runner list is invalidated)", async () => {
		reg.mutateAsync.mockResolvedValueOnce({ runner: { id: "r-1", name: "box" }, runner_token: "tok-once" });
		const user = userEvent.setup();
		render(<AddRunnerDialog open onOpenChange={() => {}} />);
		await user.click(screen.getByRole("button", { name: /register your own/i }));
		await user.type(screen.getByRole("textbox", { name: /name/i }), "box");
		await user.click(screen.getByRole("button", { name: /register runner/i }));
		expect(await screen.findByText(/save these credentials now/i)).toBeInTheDocument();
		expect(reg.mutateAsync).toHaveBeenCalledWith({ name: "box" });
		expect(reg.refresh).not.toHaveBeenCalled();
	});

	it("a server-side validation refusal lands on the name field, and the form stays", async () => {
		reg.mutateAsync.mockImplementationOnce(async () => {
			reg.onValidationError?.({ name: ["That name is taken"] });
			throw new Error("refused");
		});
		const user = userEvent.setup();
		render(<AddRunnerDialog open onOpenChange={() => {}} />);
		await user.click(screen.getByRole("button", { name: /register your own/i }));
		await user.type(screen.getByRole("textbox", { name: /name/i }), "box");
		await user.click(screen.getByRole("button", { name: /register runner/i }));
		expect(await screen.findByText("That name is taken")).toBeInTheDocument();
		expect(screen.queryByText(/save these credentials now/i)).toBeNull();
	});
});

describe("AddRunnerDialog — the deploy path's cloud-account read (R6 C-03)", () => {
	it("while the read is in flight the pane is a skeleton, not 'No AWS account connected'", async () => {
		vi.mocked(getVerifiedCloudIdentitiesByProvider).mockImplementation(() => new Promise(() => {}));
		const user = userEvent.setup();
		render(<AddRunnerDialog open onOpenChange={() => {}} />);
		await user.click(screen.getByRole("button", { name: /deploy to a cloud/i }));
		expect(screen.getByText(/loading your cloud accounts/i)).toBeInTheDocument();
		expect(screen.queryByText(/no aws account connected/i)).toBeNull();
	});

	it("a failed read is an error with a retry, and the retry reads again", async () => {
		vi.mocked(getVerifiedCloudIdentitiesByProvider).mockRejectedValueOnce(new Error("network"));
		const user = userEvent.setup();
		render(<AddRunnerDialog open onOpenChange={() => {}} />);
		await user.click(screen.getByRole("button", { name: /deploy to a cloud/i }));
		expect(await screen.findByText(/couldn't load your cloud accounts/i)).toBeInTheDocument();
		expect(screen.queryByText(/no aws account connected/i)).toBeNull();

		vi.mocked(getVerifiedCloudIdentitiesByProvider).mockResolvedValueOnce([]);
		await user.click(screen.getByRole("button", { name: /try again/i }));
		expect(await screen.findByRole("heading", { name: /no aws account connected/i })).toBeInTheDocument();
		expect(getVerifiedCloudIdentitiesByProvider).toHaveBeenCalledTimes(2);
	});
});

describe("AddRunnerDialog — a deploy needs a runner to run it (R6 C-21)", () => {
	it("with zero runners the deploy is disabled with its reason, and Register is offered", async () => {
		vi.mocked(getVerifiedCloudIdentitiesByProvider).mockResolvedValue([AWS_ACCOUNT]);
		const user = userEvent.setup();
		render(<AddRunnerDialog open onOpenChange={() => {}} />);
		await user.click(screen.getByRole("button", { name: /deploy to a cloud/i }));

		const deploy = await screen.findByRole("button", { name: /deploy runner/i });
		expect(deploy).toBeDisabled();
		expect(document.body.textContent).toContain("A deploy runs on an existing runner. Register one first.");

		await user.click(screen.getByRole("button", { name: /register a runner/i }));
		expect(screen.getByRole("button", { name: /register runner/i })).toBeInTheDocument();
	});

	it("with a runner, the deploy is not gated on one", async () => {
		reg.runners = [{ id: "r1", name: "edge", status: "ONLINE", is_default: true, operator: "self" }];
		vi.mocked(getVerifiedCloudIdentitiesByProvider).mockResolvedValue([AWS_ACCOUNT]);
		const user = userEvent.setup();
		render(<AddRunnerDialog open onOpenChange={() => {}} />);
		await user.click(screen.getByRole("button", { name: /deploy to a cloud/i }));
		await screen.findByRole("button", { name: /deploy runner/i });
		expect(document.body.textContent).not.toContain("Register one first");
		expect(screen.queryByRole("button", { name: /register a runner/i })).toBeNull();
	});
});

describe("AddRunnerDialog — the one-time token (R6 C-02)", () => {
	/** Registers a runner and returns once its credentials are on screen. */
	async function showCredentials(onOpenChange: (open: boolean) => void) {
		reg.mutateAsync.mockResolvedValueOnce({ runner: { id: "r-1", name: "box" }, runner_token: "tok-once" });
		const user = userEvent.setup();
		render(<AddRunnerDialog open onOpenChange={onOpenChange} />);
		await user.click(screen.getByRole("button", { name: /register your own/i }));
		await user.type(screen.getByRole("textbox", { name: /name/i }), "box");
		await user.click(screen.getByRole("button", { name: /register runner/i }));
		expect(await screen.findByText(/save these credentials now/i)).toBeInTheDocument();
		return user;
	}

	it("draws no corner close button while the token is shown, and Escape does not close it", async () => {
		const onOpenChange = vi.fn();
		const user = await showCredentials(onOpenChange);
		expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
		await user.keyboard("{Escape}");
		expect(onOpenChange).not.toHaveBeenCalledWith(false);
		expect(screen.getByText(/save these credentials now/i)).toBeInTheDocument();
	});

	it("Done closes it", async () => {
		const onOpenChange = vi.fn();
		const user = await showCredentials(onOpenChange);
		await user.click(screen.getByRole("button", { name: "Done" }));
		expect(onOpenChange).toHaveBeenCalledWith(false);
	});

	it("before the token exists, the sheet closes as any sheet does", async () => {
		const onOpenChange = vi.fn();
		render(<AddRunnerDialog open onOpenChange={onOpenChange} />);
		expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
	});
});
