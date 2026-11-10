// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #5454 — the promote dialog says WHY a promotion was refused, inside the dialog.
//
// `promoteEnvironment` used to THROW its refusals ("already in progress", "only an equal or higher
// stage", and every gate the PLAN runs), and the dialog toasted `err.message`. A production build
// replaces a thrown server-action message with a digest, so the user was told nothing they could
// act on. The action now RETURNS `{ ok: false, error }`; this file pins the half the user sees: the
// sentence is rendered in the dialog and describes the Promote button, nothing is toasted, the
// dialog stays open, and the caller is not told a promotion landed.
//
// Against the old dialog the refusal case fails: it awaited the result without reading it, toasted
// "Promotion queued", closed itself and called `onPromoted`.
//
// #6120: the action is on the mutation contract — one object in, an `ActionResult` out, a refusal
// as `{ kind: "conflict", message }` — and the preview is the `environments.promotionPreview` GET
// procedure. The half the user sees is unchanged, and the refusal is still NOT toasted: the dialog
// takes it over from the toast (`useActionMutation`'s `onRefusal`), so it is said once.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeCall, FakeHandler } from "@/tests/helpers/fake-orpc";

const promoteEnvironment = vi.fn();
const toastError = vi.fn();
const toastSuccess = vi.fn();
const h = vi.hoisted(() => ({
	handlers: {} as Record<string, FakeHandler>,
	calls: [] as FakeCall[],
}));

vi.mock("@/lib/rpc/client", async () => {
	const { fakeOrpc } = await import("@/tests/helpers/fake-orpc");
	return { orpc: fakeOrpc(h.handlers, h.calls).orpc };
});
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("@/app/server/actions/promotions", () => ({
	promoteEnvironment: (...a: unknown[]) => promoteEnvironment(...a),
}));
vi.mock("sonner", () => ({
	toast: {
		error: (...a: unknown[]) => toastError(...a),
		success: (...a: unknown[]) => toastSuccess(...a),
	},
}));

import { PromoteDialog } from "@/components/environments/promote-dialog";

const ENVS = [
	{ id: "env-dev", name: "development", stage: "development" },
	{ id: "env-stg", name: "staging", stage: "staging" },
	{ id: "env-prod", name: "production", stage: "production" },
];

const REFUSAL =
	"No cloud account linked to this project. Go to Connectors to connect. The promotion was stopped and production was left as it was.";

/** Renders the open dialog and drives the From/To pair to development → production. */
async function renderAndPick() {
	const onOpenChange = vi.fn();
	const onPromoted = vi.fn();
	const user = userEvent.setup();
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	render(
		<QueryClientProvider client={client}>
			<PromoteDialog
				open
				onOpenChange={onOpenChange}
				projectId="p1"
				envs={ENVS}
				onPromoted={onPromoted}
			/>
		</QueryClientProvider>,
	);
	await user.click(await screen.findByRole("combobox", { name: "From" }));
	await user.click(await screen.findByRole("option", { name: "development" }));
	await user.click(await screen.findByRole("combobox", { name: "To" }));
	await user.click(await screen.findByRole("option", { name: "production" }));
	// The preview has to land before Promote is enabled.
	await screen.findByText("1 add");
	return { user, onOpenChange, onPromoted };
}

beforeEach(() => {
	vi.clearAllMocks();
	h.calls.length = 0;
	h.handlers["environments.promotionPreview"] = async () => ({
		sourceId: "env-dev",
		targetId: "env-prod",
		diff: {
			changes: [{ component_type: "service", key: "api", op: "CREATE" }],
			summary: ["1 add"],
			include_removals: false,
		},
	});
});

describe("PromoteDialog — a refused promotion", () => {
	it("renders the server's sentence in the dialog, toasts nothing, and stays open", async () => {
		promoteEnvironment.mockResolvedValue({ ok: false, error: { kind: "conflict", message: REFUSAL } });
		const { user, onOpenChange, onPromoted } = await renderAndPick();

		const button = screen.getByRole("button", { name: "Promote" });
		await user.click(button);

		const alert = await screen.findByRole("alert");
		expect(alert).toHaveTextContent(REFUSAL);
		expect(button).toHaveAttribute("aria-describedby", alert.id);
		expect(promoteEnvironment).toHaveBeenCalledWith({
			projectId: "p1",
			sourceEnvId: "env-dev",
			targetEnvId: "env-prod",
			includeRemovals: false,
		});
		expect(toastError).not.toHaveBeenCalled();
		expect(toastSuccess).not.toHaveBeenCalled();
		expect(onPromoted).not.toHaveBeenCalled();
		expect(onOpenChange).not.toHaveBeenCalledWith(false);
	});

	it("clears the sentence once the pair changes, because it answered the old request", async () => {
		promoteEnvironment.mockResolvedValue({ ok: false, error: { kind: "conflict", message: REFUSAL } });
		const { user } = await renderAndPick();
		await user.click(screen.getByRole("button", { name: "Promote" }));
		await screen.findByRole("alert");

		await user.click(screen.getByRole("combobox", { name: "To" }));
		await user.click(await screen.findByRole("option", { name: "staging" }));

		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	});
});

describe("PromoteDialog — a queued promotion", () => {
	it("toasts, closes and tells the caller", async () => {
		promoteEnvironment.mockResolvedValue({
			ok: true,
			data: { promotionId: "promo-1", planJobId: "job-1" },
		});
		const { user, onOpenChange, onPromoted } = await renderAndPick();
		await user.click(screen.getByRole("button", { name: "Promote" }));

		await vi.waitFor(() => expect(toastSuccess).toHaveBeenCalledWith("Promotion queued"));
		expect(onOpenChange).toHaveBeenCalledWith(false);
		expect(onPromoted).toHaveBeenCalled();
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	});
});

describe("PromoteDialog — the preview read", () => {
	it("asks the preview procedure for the chosen pair, not a server action", async () => {
		await renderAndPick();
		expect(h.calls).toContainEqual({
			path: "environments.promotionPreview",
			input: { projectId: "p1", sourceId: "env-dev", targetId: "env-prod", includeRemovals: false },
		});
	});

	it("renders a failed preview as an error with a retry — not as 'already aligned'", async () => {
		h.handlers["environments.promotionPreview"] = async () => {
			throw new Error("boom");
		};
		const onOpenChange = vi.fn();
		const user = userEvent.setup();
		const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		render(
			<QueryClientProvider client={client}>
				<PromoteDialog open onOpenChange={onOpenChange} projectId="p1" envs={ENVS} onPromoted={vi.fn()} />
			</QueryClientProvider>,
		);
		await user.click(await screen.findByRole("combobox", { name: "From" }));
		await user.click(await screen.findByRole("option", { name: "development" }));
		await user.click(await screen.findByRole("combobox", { name: "To" }));
		await user.click(await screen.findByRole("option", { name: "production" }));

		expect(await screen.findByText("Couldn't compute the changes")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
		expect(screen.queryByText(/already aligned/)).not.toBeInTheDocument();
	});
});
