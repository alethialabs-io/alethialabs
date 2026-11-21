// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The deploy form's identity source. It used to be the UNFILTERED list, so a user whose only
// verified cloud was GCP could pick it — and CloudIdentitySelector auto-selects a lone identity,
// so the unbuildable choice arrived pre-filled. The filter is now the `runners.deployableAccounts`
// procedure's (tests/lib/rpc/runners-procedures.test.ts pins it); these pin that the sheet reads
// that procedure only while it is open, that each of the read's states renders as its own thing,
// and that a user with no deployable account reads a truthful boundary instead of a form whose job
// dies later in the runner log.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

/** One verified AWS account, as the deploy path's read returns it. */
const AWS_ACCOUNT = { id: "id-aws", name: "prod", displayId: "123456789012", provider: "aws" };

/** The cloud-account read's state as the query hook reports it. */
interface AccountsState {
	data: (typeof AWS_ACCOUNT)[] | undefined;
	isError: boolean;
	isFetching: boolean;
}

const acc = vi.hoisted(() => {
	const state: AccountsState = { data: [], isError: false, isFetching: false };
	return { state, openArgs: Array<boolean>(), refetch: vi.fn() };
});

const reg = vi.hoisted(() => ({
	mutateAsync: vi.fn(),
	onValidationError: undefined as undefined | ((fields: Record<string, string[] | undefined>) => void),
	refresh: vi.fn(),
	runners: [] as { id: string; name: string; status: string; is_default: boolean; operator: string }[],
}));
vi.mock("@/lib/query/use-runners-query", () => ({
	useRunnersQuery: () => ({ data: { runners: reg.runners }, isPending: false, isError: false, refetch: vi.fn() }),
	useDeployRunner: () => ({ mutate: vi.fn(), isPending: false }),
	useDeployableAccountsQuery: (open: boolean) => {
		acc.openArgs.push(open);
		return { ...acc.state, refetch: acc.refetch };
	},
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

/** Sets what the cloud-account read reports on the next render. */
function accounts(state: AccountsState) {
	acc.state = state;
}

beforeEach(() => {
	vi.clearAllMocks();
	reg.runners = [];
	acc.openArgs = [];
	// Every test starts from a settled "none connected" answer.
	accounts({ data: [], isError: false, isFetching: false });
});

describe("AddRunnerDialog — deploy path", () => {
	it("reads the cloud accounts only while the sheet is open", () => {
		const { rerender } = render(<AddRunnerDialog open={false} onOpenChange={() => {}} />);
		expect(acc.openArgs.every((open) => open === false)).toBe(true);
		rerender(<AddRunnerDialog open onOpenChange={() => {}} />);
		expect(acc.openArgs.at(-1)).toBe(true);
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
		accounts({ data: undefined, isError: false, isFetching: true });
		const user = userEvent.setup();
		render(<AddRunnerDialog open onOpenChange={() => {}} />);
		await user.click(screen.getByRole("button", { name: /deploy to a cloud/i }));
		expect(screen.getByText(/loading your cloud accounts/i)).toBeInTheDocument();
		expect(screen.queryByText(/no aws account connected/i)).toBeNull();
	});

	it("a failed read is an error with a retry, and the retry reads again", async () => {
		accounts({ data: undefined, isError: true, isFetching: false });
		const user = userEvent.setup();
		const { rerender } = render(<AddRunnerDialog open onOpenChange={() => {}} />);
		await user.click(screen.getByRole("button", { name: /deploy to a cloud/i }));
		expect(await screen.findByText(/couldn't load your cloud accounts/i)).toBeInTheDocument();
		expect(screen.queryByText(/no aws account connected/i)).toBeNull();

		await user.click(screen.getByRole("button", { name: /try again/i }));
		expect(acc.refetch).toHaveBeenCalledTimes(1);

		// The retry in flight renders as pending again, not as the error it is replacing.
		accounts({ data: undefined, isError: true, isFetching: true });
		rerender(<AddRunnerDialog open onOpenChange={() => {}} />);
		expect(screen.getByText(/loading your cloud accounts/i)).toBeInTheDocument();
		expect(screen.queryByText(/couldn't load your cloud accounts/i)).toBeNull();

		accounts({ data: [], isError: false, isFetching: false });
		rerender(<AddRunnerDialog open onOpenChange={() => {}} />);
		expect(await screen.findByRole("heading", { name: /no aws account connected/i })).toBeInTheDocument();
	});

	it("a cached answer renders at once while it is re-read", async () => {
		accounts({ data: [AWS_ACCOUNT], isError: false, isFetching: true });
		const user = userEvent.setup();
		render(<AddRunnerDialog open onOpenChange={() => {}} />);
		await user.click(screen.getByRole("button", { name: /deploy to a cloud/i }));
		expect(await screen.findByRole("button", { name: /deploy runner/i })).toBeInTheDocument();
		expect(screen.queryByText(/loading your cloud accounts/i)).toBeNull();
	});
});

describe("AddRunnerDialog — a deploy needs a runner to run it (R6 C-21)", () => {
	it("with zero runners the deploy is disabled with its reason, and Register is offered", async () => {
		accounts({ data: [AWS_ACCOUNT], isError: false, isFetching: false });
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
		accounts({ data: [AWS_ACCOUNT], isError: false, isFetching: false });
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
