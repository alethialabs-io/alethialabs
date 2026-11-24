// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6800 — deleting an environment from the Environments page.
//
// `deleteEnvironment` returns an `ActionResult`. The page passes it to `useActionMutation` as it is,
// so a refusal is a failure: the confirmation stays open and shows the server's sentence, and
// nothing reports a delete. The confirmation states the live-environment rule before anything is
// sent.
//
// Against the page before this unit the refusal case fails twice: the action was wrapped in an
// adapter that reports whatever the action RETURNS as a success, so a returned refusal closed the
// dialog and toasted "Deleted production".

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeHandler } from "@/tests/helpers/fake-orpc";

const h = vi.hoisted(() => ({
	handlers: {} as Record<string, FakeHandler>,
	deleteEnvironment: vi.fn(),
	toast: { success: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/rpc/client", async () => {
	const { fakeOrpc } = await import("@/tests/helpers/fake-orpc");
	return { orpc: fakeOrpc(h.handlers).orpc };
});
vi.mock("next/navigation", () => {
	const search = new URLSearchParams();
	return {
		useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
		usePathname: () => "/acme/payments/environments",
		useSearchParams: () => search,
	};
});
vi.mock("sonner", () => ({ toast: h.toast }));
vi.mock("@/app/server/actions/projects", () => ({
	addEnvironment: vi.fn(),
	deleteEnvironment: h.deleteEnvironment,
	duplicateEnvironment: vi.fn(),
	setAutoHeal: vi.fn(),
	setByoAdmissionEnforce: vi.fn(),
}));
vi.mock("@/app/server/actions/missing-cluster", () => ({ markEnvironmentDestroyedAction: vi.fn() }));
vi.mock("@/app/server/actions/promotions", () => ({
	approvePromotion: vi.fn(),
	cancelPromotion: vi.fn(),
	promoteEnvironment: vi.fn(),
	rejectPromotion: vi.fn(),
}));
vi.mock("@/app/server/actions/protection", () => ({ setProtectionRules: vi.fn() }));
// The classification chips are their own unit's read; here they are empty.
vi.mock("@/lib/query/use-classification-query", () => ({
	useAssignmentsForKind: () => ({ data: {} }),
}));
vi.mock("@/components/classification/classification-control", () => ({
	ClassificationControl: () => null,
}));

import { EnvironmentsView } from "@/components/environments/environments-view";
import { orpc } from "@/lib/rpc/client";
import type { EnvironmentsOverview } from "@/lib/rpc/procedures/environments";
import { DEV, PROJECT_ID, envRow, overviewOf, pageOf, seedLists } from "./fixtures";

const KEY = orpc.environments.overview.queryKey({ input: { project: "payments" } });

/** The server's sentence for a live or in-flight environment (lib/db/live-env-statuses.ts). */
const LIVE_REFUSAL = "Destroy this environment before deleting it.";

/** A default environment (no delete control) and one non-default environment, `production`. */
const OVERVIEW: EnvironmentsOverview = overviewOf();

/** Renders the page over a cache that already holds `overview`, as the route's prefetch leaves it. */
function renderView(overview: EnvironmentsOverview = OVERVIEW) {
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: false, staleTime: Infinity },
			mutations: { retry: false },
		},
	});
	client.setQueryData(KEY, overview);
	seedLists(client, overview);
	return render(
		<QueryClientProvider client={client}>
			<EnvironmentsView org="acme" project="payments" />
		</QueryClientProvider>,
	);
}

/** Opens the delete confirmation for `name` through its row's menu and returns the dialog. */
async function openDelete(user: ReturnType<typeof userEvent.setup>, name = "production") {
	await user.click(screen.getByRole("button", { name: `Environment actions for ${name}` }));
	await user.click(await screen.findByRole("menuitem", { name: "Delete" }));
	return screen.findByRole("alertdialog");
}

/** Types the environment's name and presses the primary button. */
async function confirmDelete(user: ReturnType<typeof userEvent.setup>, dialog: HTMLElement, name = "production") {
	await user.type(within(dialog).getByRole("textbox"), name);
	await user.click(within(dialog).getByRole("button", { name: "Delete environment" }));
}

beforeEach(() => {
	vi.clearAllMocks();
	// The delete invalidates the page's read; the refetch answers with the same overview.
	h.handlers["environments.overview"] = async () => OVERVIEW;
	h.handlers["environments.page"] = async () => pageOf(OVERVIEW.envs);
	h.handlers["environments.promotions"] = async () => ({ rows: [], nextCursor: null, facets: null, universeEmpty: true });
});

describe("EnvironmentsView — deleting an environment (#6800)", () => {
	it("states the live-environment rule before anything is sent", async () => {
		const user = userEvent.setup();
		renderView();
		const dialog = await openDelete(user);

		expect(dialog).toHaveTextContent(
			"An environment that is live or in flight cannot be deleted: destroy it first.",
		);
		expect(dialog).toHaveTextContent("destroys nothing in the cloud");
		expect(dialog).not.toHaveTextContent("Provisioned infrastructure is not destroyed");
		expect(h.deleteEnvironment).not.toHaveBeenCalled();
	});

	it("is a typed confirmation: the primary button waits for the environment's name, and lists what goes", async () => {
		const user = userEvent.setup();
		renderView();
		const dialog = await openDelete(user);

		const primary = within(dialog).getByRole("button", { name: "Delete environment" });
		expect(primary).toBeDisabled();
		expect(dialog).toHaveTextContent("The environment record");
		expect(dialog).toHaveTextContent("Its staged configuration");
		await user.type(within(dialog).getByRole("textbox"), "productio");
		expect(primary).toBeDisabled();
		await user.type(within(dialog).getByRole("textbox"), "n");
		expect(primary).toBeEnabled();
		expect(h.deleteEnvironment).not.toHaveBeenCalled();
	});

	it("for a FAILED environment it says cloud resources may be left, and to destroy first", async () => {
		const user = userEvent.setup();
		renderView(overviewOf({ envs: [DEV, envRow({ id: "env-qa", name: "qa", status: "FAILED" })] }));
		const dialog = await openDelete(user, "qa");

		expect(dialog).toHaveTextContent("last run failed, so it may still have cloud resources");
		expect(dialog).toHaveTextContent("destroys nothing in the cloud");
		expect(dialog).toHaveTextContent("Destroy the environment first to remove it.");
		expect(h.deleteEnvironment).not.toHaveBeenCalled();
	});

	it("a refused delete stays open and shows the server's sentence — it is not reported as deleted", async () => {
		h.deleteEnvironment.mockResolvedValue({
			ok: false,
			error: { kind: "conflict", message: LIVE_REFUSAL },
		});
		const user = userEvent.setup();
		renderView();
		const dialog = await openDelete(user);
		await confirmDelete(user, dialog);

		await waitFor(() => expect(dialog).toHaveTextContent(`Not deleted. ${LIVE_REFUSAL}`));
		expect(h.deleteEnvironment).toHaveBeenCalledTimes(1);
		expect(h.deleteEnvironment).toHaveBeenCalledWith({
			projectId: PROJECT_ID,
			environmentId: "env-prod",
		});
		expect(screen.getByRole("alertdialog")).toBeInTheDocument();
		expect(h.toast.success).not.toHaveBeenCalled();
		// The sentence is in the dialog, so it is not toasted as well.
		expect(h.toast.error).not.toHaveBeenCalled();
	});

	it("opening the confirmation again after a refusal starts from the rule, not the old refusal", async () => {
		h.deleteEnvironment.mockResolvedValue({
			ok: false,
			error: { kind: "conflict", message: LIVE_REFUSAL },
		});
		const user = userEvent.setup();
		renderView();
		const first = await openDelete(user);
		await confirmDelete(user, first);
		await waitFor(() => expect(first).toHaveTextContent(`Not deleted. ${LIVE_REFUSAL}`));
		await user.click(within(first).getByRole("button", { name: "Cancel" }));
		await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());

		const second = await openDelete(user);
		expect(second).toHaveTextContent("cannot be deleted: destroy it first.");
		expect(second).not.toHaveTextContent("Not deleted.");
	});

	it("a delete the server accepts closes the confirmation and names what was deleted", async () => {
		h.deleteEnvironment.mockResolvedValue({ ok: true, data: { name: "production" } });
		const user = userEvent.setup();
		renderView();
		const dialog = await openDelete(user);
		await confirmDelete(user, dialog);

		await waitFor(() => expect(h.toast.success).toHaveBeenCalledWith("Deleted production"));
		await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
		expect(h.toast.error).not.toHaveBeenCalled();
	});

	it("a failure that is not a refusal is toasted, and the confirmation keeps the rule", async () => {
		h.deleteEnvironment.mockResolvedValue({ ok: false, error: { kind: "unexpected", ref: "ab12cd34" } });
		const user = userEvent.setup();
		renderView();
		const dialog = await openDelete(user);
		await confirmDelete(user, dialog);

		await waitFor(() =>
			expect(h.toast.error).toHaveBeenCalledWith(
				"Something went wrong on our side. Reference: ab12cd34",
			),
		);
		expect(screen.getByRole("alertdialog")).toHaveTextContent("cannot be deleted: destroy it first.");
		expect(h.toast.success).not.toHaveBeenCalled();
	});
});
