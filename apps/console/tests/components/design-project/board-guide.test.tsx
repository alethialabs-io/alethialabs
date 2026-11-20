// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6836 — how a board starts. An empty board is never a blank grid: it says what the board is and
// offers three starts that each do something; and a `?seed=` from the create screen is applied to
// the draft once, as one undo step, then removed from the URL.
//
// What is real here: `BoardGuide`, the board's document and view stores, the hand-off contract,
// TanStack Query. What is a stand-in: the URL (jsdom's own, read by the navigation mock), the
// server's offered-cloud list (the `connectors.board` read), and the cards beside the design.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeCall, FakeHandler } from "@/tests/helpers/fake-orpc";

const h = vi.hoisted(() => ({
	handlers: {} as Record<string, FakeHandler>,
	calls: [] as FakeCall[],
	replace: vi.fn(),
}));

vi.mock("@/lib/rpc/client", async () => {
	const { fakeOrpc } = await import("@/tests/helpers/fake-orpc");
	return { orpc: fakeOrpc(h.handlers, h.calls).orpc };
});
// The URL is jsdom's: a test sets it with `history.replaceState`, the guide reads it here and
// rewrites it through `router.replace`, which the test then inspects.
vi.mock("next/navigation", () => ({
	useRouter: () => ({ push: vi.fn(), replace: h.replace, refresh: vi.fn() }),
	useSearchParams: () => new URLSearchParams(window.location.search),
}));
// The cards beside the design (add-ons, charts, an IaC module's resources): none.
vi.mock("@/lib/query/use-addons-query", () => ({ useAddonsQuery: () => ({ data: undefined }) }));
vi.mock("@/lib/canvas/environment-status-context", () => ({
	useEnvironmentStatus: () => ({ iac: null }),
}));

const { BoardGuide, PROPOSAL_PENDING, SEED_UNCHECKED } = await import(
	"@/components/design-project/canvas/board-guide"
);
const { BOARD_SENTENCE, NOT_ENABLED } = await import(
	"@/components/design-project/canvas/empty/board-guide-view"
);
const { formToGraph } = await import("@/components/design-project/canvas/graph/form-to-graph");
const { buildDefaultFormValues } = await import("@/components/design-project/source-project");
const { PROVIDERS } = await import("@/lib/cloud-providers");
const { board } = await import("@/lib/canvas/store/board");
const { CanvasStoreProvider } = await import("@/lib/canvas/store/canvas-store-provider");
const { pendingCount } = await import("@/lib/canvas/store/document-store");
const { draftStorageKey } = await import("@/lib/canvas/store/draft-persist");

const SCOPE = "proj-1:env-a";
const PATH = "/acme/shop/architecture";
/** What the server says this deployment offers. `cloudflare` is offered and runs no cluster. */
const OFFERED = ["aws", "gcp", "azure", "hetzner", "cloudflare"];
const AWS_IDENTITY = { id: "ident-aws", name: "prod", displayId: "1111", provider: "aws" };

/** Load a new project's design on the board: a cluster and a network, nothing drawn. */
function seedBoard(options: { bound: boolean } = { bound: false }) {
	const base = buildDefaultFormValues();
	const form = options.bound
		? { ...base, project: { ...base.project, cloud_identity_id: AWS_IDENTITY.id } }
		: base;
	board.reseed(formToGraph(form, [AWS_IDENTITY]), { scope: SCOPE, revision: "r1" });
}

/** Point the URL at the board, with `query` after the `?`. */
function visit(query = "") {
	window.history.replaceState(null, "", query === "" ? PATH : `${PATH}?${query}`);
}

/** The guide's handlers, so a test can see which start was taken. */
function handlers() {
	return { onAdd: vi.fn(), onAttachChart: vi.fn(), onAttachIac: vi.fn() };
}

/** The guide as the canvas mounts it, over the board in scope. */
function guide(
	on: { onAdd: () => void; onAttachChart?: () => void; onAttachIac?: () => void },
	governed = false,
): ReactElement {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return (
		<QueryClientProvider client={client}>
			<CanvasStoreProvider scope={SCOPE} identities={[AWS_IDENTITY]}>
				<BoardGuide projectId="proj-1" environmentId="env-a" governed={governed} {...on} />
			</CanvasStoreProvider>
		</QueryClientProvider>
	);
}

/** The cluster's machine types as the draft holds them. */
function machineTypes(): unknown {
	const cluster = board.document.getState().designNodes.find((n) => n.data.kind === "cluster");
	return cluster?.data.kind === "cluster" ? cluster.data.config.instance_types : undefined;
}

beforeEach(() => {
	vi.clearAllMocks();
	h.calls.length = 0;
	h.handlers["connectors.board"] = async () => ({ offeredClouds: OFFERED });
	sessionStorage.clear();
	board.reset();
	board.openDraftScope(SCOPE);
	seedBoard();
	visit();
});

describe("an empty board is a guide, not a blank grid", () => {
	it("says in one sentence what the board is, and offers three ways to start", () => {
		render(guide(handlers()));
		expect(screen.getByText(BOARD_SENTENCE)).toBeInTheDocument();
		const starts = within(screen.getByRole("list", { name: "Ways to start" }));
		expect(starts.getAllByRole("listitem")).toHaveLength(3);
		expect(starts.getByText("Start from a template")).toBeInTheDocument();
		expect(starts.getByText("Add the first piece yourself")).toBeInTheDocument();
		expect(starts.getByText("Bring your own")).toBeInTheDocument();
	});

	it("renders inside the shared empty-state region, named on its overlay", () => {
		render(guide(handlers()));
		const sentence = screen.getByText(BOARD_SENTENCE);
		expect(sentence.closest('[data-slot="empty"]')).not.toBeNull();
		expect(sentence.closest('[data-slot="board-guide"]')).not.toBeNull();
	});

	it("each start does something: add, attach a chart, attach IaC, open the cluster", async () => {
		const on = handlers();
		const user = userEvent.setup();
		render(guide(on));

		await user.click(screen.getByRole("button", { name: "Add a component" }));
		expect(on.onAdd).toHaveBeenCalledTimes(1);
		await user.click(screen.getByRole("button", { name: "Attach a Helm chart" }));
		expect(on.onAttachChart).toHaveBeenCalledTimes(1);
		await user.click(screen.getByRole("button", { name: "Attach an IaC module" }));
		expect(on.onAttachIac).toHaveBeenCalledTimes(1);

		await user.click(screen.getByRole("button", { name: "Open cluster settings" }));
		expect(board.view.getState().card).toEqual({ kind: "env-settings" });
	});

	it("is operable from the keyboard alone", async () => {
		const on = handlers();
		const user = userEvent.setup();
		render(guide(on));
		const add = screen.getByRole("button", { name: "Add a component" });
		add.focus();
		await user.keyboard("{Enter}");
		expect(on.onAdd).toHaveBeenCalledTimes(1);
	});

	it("an attach flow the instance has off is disabled and says why", () => {
		render(guide({ onAdd: vi.fn() }));
		for (const name of ["Attach a Helm chart", "Attach an IaC module"]) {
			const button = screen.getByRole("button", { name });
			expect(button).toBeDisabled();
			expect(button).toHaveAccessibleDescription(NOT_ENABLED);
		}
	});

	it("is gone the moment the board has a card", () => {
		render(guide(handlers()));
		expect(screen.getByText(BOARD_SENTENCE)).toBeInTheDocument();
		act(() => {
			board.document.getState().addNode("database");
		});
		expect(screen.queryByText(BOARD_SENTENCE)).not.toBeInTheDocument();
	});

	it("is not shown while an IaC module governs the environment", () => {
		render(guide(handlers(), true));
		expect(screen.queryByText(BOARD_SENTENCE)).not.toBeInTheDocument();
	});
});

describe("starting from a template", () => {
	it("a project with no cloud picks from the clouds the SERVER offers, a cluster can run on", async () => {
		render(guide(handlers()));
		const clouds = within(await screen.findByRole("group", { name: "Cloud to size for" }));
		expect(clouds.getAllByRole("button").map((b) => b.textContent)).toEqual(
			[PROVIDERS.aws, PROVIDERS.gcp, PROVIDERS.azure, PROVIDERS.hetzner].map((p) => p.shortName),
		);
		expect(h.calls.map((c) => c.path)).toEqual(["connectors.board"]);
	});

	it("is disabled, with the reason, until the offered clouds have loaded", async () => {
		let answer: (value: unknown) => void = () => {};
		h.handlers["connectors.board"] = () =>
			new Promise((resolve) => {
				answer = resolve;
			});
		render(guide(handlers()));
		const standard = screen.getByRole("button", { name: "Start from the Standard template" });
		expect(standard).toBeDisabled();
		expect(standard).toHaveAccessibleDescription("Loading the clouds available here.");
		await act(async () => {
			answer({ offeredClouds: OFFERED });
		});
		await waitFor(() =>
			expect(screen.getByRole("button", { name: "Start from the Standard template" })).toBeEnabled(),
		);
	});

	it("says so when the offered clouds cannot be loaded", async () => {
		h.handlers["connectors.board"] = async () => {
			throw new Error("unreachable");
		};
		render(guide(handlers()));
		await waitFor(() =>
			expect(
				screen.getByRole("button", { name: "Start from the Standard template" }),
			).toHaveAccessibleDescription(/could not be loaded/),
		);
	});

	it("sizes the cluster as pending changes and ONE undo step that restores the empty board", async () => {
		const user = userEvent.setup();
		render(guide(handlers()));
		const before = board.document.getState().designNodes;
		const pendingBefore = pendingCount(board.document.getState());

		const clouds = within(await screen.findByRole("group", { name: "Cloud to size for" }));
		await user.click(clouds.getByRole("button", { name: PROVIDERS.hetzner.shortName }));
		await user.click(screen.getByRole("button", { name: "Start from the Standard template" }));

		expect(pendingCount(board.document.getState())).toBeGreaterThan(pendingBefore);
		expect(board.document.getState().history.past).toHaveLength(1);
		// What it sized is on screen: the cluster's settings open, and the guide says what happened.
		expect(board.view.getState().card).toEqual({ kind: "env-settings" });
		expect(screen.getByRole("status")).toHaveTextContent(
			`The cluster is sized from the Standard template for ${PROVIDERS.hetzner.name}.`,
		);

		act(() => board.undo([]));
		expect(board.document.getState().designNodes).toEqual(before);
		expect(pendingCount(board.document.getState())).toBe(pendingBefore);
		expect(screen.queryByRole("status")).not.toBeInTheDocument();
		// Still an empty board, so still the guide.
		expect(screen.getByText(BOARD_SENTENCE)).toBeInTheDocument();
	});

	it("a project bound to a cloud account is sized for that cloud, and nothing is asked", () => {
		board.reset();
		board.openDraftScope(SCOPE);
		seedBoard({ bound: true });
		render(guide(handlers()));
		expect(screen.getByText(new RegExp(PROVIDERS.aws.name))).toBeInTheDocument();
		expect(screen.queryByRole("group", { name: "Cloud to size for" })).not.toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Start from the Standard template" })).toBeEnabled();
		// The offered list is not read when nothing needs it.
		expect(h.calls).toEqual([]);
	});
});

describe("a seed from the create screen", () => {
	it("a template seed is applied once as one undo step, and the param is removed", async () => {
		visit("environment_id=env-a&seed=v1.template.standard.hetzner");
		const before = board.document.getState().designNodes;
		const pendingBefore = pendingCount(board.document.getState());
		render(guide(handlers()));

		await waitFor(() => expect(h.replace).toHaveBeenCalled());
		expect(h.replace).toHaveBeenCalledWith(`${PATH}?environment_id=env-a`, { scroll: false });
		expect(pendingCount(board.document.getState())).toBeGreaterThan(pendingBefore);
		expect(board.document.getState().history.past).toHaveLength(1);
		expect(board.document.getState().appliedSeedKeys).toEqual(["v1.template.standard.hetzner"]);

		act(() => board.undo([]));
		expect(board.document.getState().designNodes).toEqual(before);
	});

	it("is not applied a second time by a remount with the same link", async () => {
		visit("seed=v1.template.standard.hetzner");
		const first = render(guide(handlers()));
		await waitFor(() => expect(h.replace).toHaveBeenCalledTimes(1));
		const applied = board.document.getState().designNodes;
		first.unmount();

		render(guide(handlers()));
		// The link is still dealt with — the param is removed — and the design is untouched.
		await waitFor(() => expect(h.replace).toHaveBeenCalledTimes(2));
		expect(board.document.getState().designNodes).toBe(applied);
		expect(board.document.getState().history.past).toHaveLength(1);
	});

	it("is not applied a second time after a reload: the draft remembers the seed", async () => {
		visit("seed=v1.template.standard.hetzner");
		const first = render(guide(handlers()));
		await waitFor(() => expect(h.replace).toHaveBeenCalledTimes(1));
		const types = machineTypes();
		first.unmount();

		// A reload: the draft is written, the tab's stores start over, and the draft is restored.
		board.flushDraft();
		const slot = draftStorageKey(SCOPE);
		const draft = sessionStorage.getItem(slot);
		board.reset();
		sessionStorage.setItem(slot, draft ?? "");
		expect(board.openDraftScope(SCOPE)).toBe(true);
		expect(board.document.getState().history.past).toHaveLength(0);
		// The user changed the cluster by hand after the seed; a second application would undo that.
		const cluster = board.document.getState().designNodes.find((n) => n.data.kind === "cluster");
		act(() => {
			board.document.getState().updateNodeConfig(cluster?.id ?? "", { instance_types: ["mine"] });
		});
		expect(machineTypes()).not.toEqual(types);

		render(guide(handlers()));
		await waitFor(() => expect(h.replace).toHaveBeenCalledTimes(2));
		expect(machineTypes()).toEqual(["mine"]);
	});

	it("a blank seed changes nothing and is removed", async () => {
		visit("seed=v1.blank");
		const before = board.document.getState().designNodes;
		render(guide(handlers()));
		await waitFor(() => expect(h.replace).toHaveBeenCalledWith(PATH, { scroll: false }));
		expect(board.document.getState().designNodes).toEqual(before);
		expect(board.document.getState().appliedSeedKeys).toEqual(["v1.blank"]);
		// Nothing changed, so there is nothing to undo.
		expect(board.document.getState().history.past).toHaveLength(0);
		expect(screen.queryByRole("status")).not.toBeInTheDocument();
	});

	it("a bring-your-own seed opens its attach flow, once", async () => {
		visit("seed=v1.byo.iac");
		const on = handlers();
		render(guide(on));
		await waitFor(() => expect(on.onAttachIac).toHaveBeenCalledTimes(1));
		expect(on.onAttachChart).not.toHaveBeenCalled();
		expect(h.replace).toHaveBeenCalledWith(PATH, { scroll: false });
	});

	it("a bring-your-own seed on an instance with that flow off says so and applies nothing", async () => {
		visit("seed=v1.byo.chart");
		render(guide({ onAdd: vi.fn() }));
		expect(await screen.findByRole("status")).toHaveTextContent(/not enabled on this instance/);
		expect(board.document.getState().appliedSeedKeys).toEqual([]);
		expect(h.replace).not.toHaveBeenCalled();
	});

	it.each([
		["nonsense", /could not be read/],
		["v9.blank", /another version/],
		["v1.template.standard.alibaba", /not available here/],
	])("a refused seed (%s) is one plain sentence over a board that works", async (seed, sentence) => {
		visit(`seed=${seed}`);
		const on = handlers();
		const user = userEvent.setup();
		const before = board.document.getState().designNodes;
		render(guide(on));

		expect(await screen.findByRole("status")).toHaveTextContent(sentence);
		expect(board.document.getState().designNodes).toBe(before);
		expect(board.document.getState().appliedSeedKeys).toEqual([]);
		// The board is usable: the guide is there and its starts work.
		await user.click(screen.getByRole("button", { name: "Add a component" }));
		expect(on.onAdd).toHaveBeenCalledTimes(1);
		// Dismissing the sentence takes the bad param out of the URL.
		expect(h.replace).not.toHaveBeenCalled();
		await user.click(screen.getByRole("button", { name: "Dismiss" }));
		expect(h.replace).toHaveBeenCalledWith(PATH, { scroll: false });
	});

	it("a refused seed's sentence shows on a board that is not empty, too", async () => {
		act(() => {
			board.document.getState().addNode("database");
		});
		visit("seed=nonsense");
		render(guide(handlers()));
		expect(await screen.findByRole("status")).toHaveTextContent(/could not be read/);
		expect(screen.queryByText(BOARD_SENTENCE)).not.toBeInTheDocument();
	});

	it("a proposal seed is 'coming with the repository scan': said, not applied, not removed", async () => {
		visit("seed=v1.proposal.0b0f4a52-7d5c-4a8e-9a53-0d6f1f1c2e11");
		const before = board.document.getState().designNodes;
		render(guide(handlers()));
		expect(await screen.findByRole("status")).toHaveTextContent(PROPOSAL_PENDING);
		expect(board.document.getState().designNodes).toBe(before);
		expect(board.document.getState().appliedSeedKeys).toEqual([]);
		expect(h.replace).not.toHaveBeenCalled();
		expect(screen.getByRole("button", { name: "Add a component" })).toBeEnabled();
	});

	it("a seed that cannot be checked, because the offered clouds did not load, is not applied", async () => {
		h.handlers["connectors.board"] = async () => {
			throw new Error("unreachable");
		};
		visit("seed=v1.template.standard.aws");
		const before = board.document.getState().designNodes;
		render(guide(handlers()));
		expect(await screen.findByRole("status")).toHaveTextContent(SEED_UNCHECKED);
		expect(board.document.getState().designNodes).toBe(before);
		expect(h.replace).not.toHaveBeenCalled();
	});
});
