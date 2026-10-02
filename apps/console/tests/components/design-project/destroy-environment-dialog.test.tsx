// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Destroying an environment that owns a cluster other environments are placed on (#5261).
//
// The server refuses that destroy unless it cascades (#5259), but a production build redacts a
// server action's error text, so the refusal naming the tenants reaches the browser as a digest.
// These pin that the card READS the destroy tree before offering to destroy, and what it then
// shows in each of the three states: nothing placed (today's confirm), live tenants (the ordered
// list and two choices), a FAILED tenant (called out) — plus the cascade path itself and the
// "waiting on" read of a destroy the claim is holding back.

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ActivityStatusLine } from "@/components/design-project/canvas/cards/activity-status-line";
import type {
	DestroyEnvironmentControl,
	DestroyTreeNode,
} from "@/components/design-project/canvas/cards/destroy-tree-view";
import { EnvSettingsCard } from "@/components/design-project/canvas/cards/env-settings-card";
import {
	EMPTY_ENVIRONMENT_STATUS,
	type EnvironmentStatus,
} from "@/lib/canvas/component-status";
import { EnvironmentStatusProvider } from "@/lib/canvas/environment-status-context";
import { useCanvasStore } from "@/lib/stores/use-canvas-store";

vi.mock("next/navigation", () => ({ useParams: () => ({ org: "acme" }) }));

/** One node of a destroy tree, shaped as `buildDestroyTree` emits it. */
function node(over: Partial<DestroyTreeNode> & Pick<DestroyTreeNode, "name">): DestroyTreeNode {
	return {
		environment_id: `env-${over.name}`,
		placement_mode: "namespace",
		status: "ACTIVE",
		owns_fabric: false,
		waiting_on: [],
		...over,
	};
}

/** The owner of a cluster, last in its tree, waiting on `tenants`. */
function owner(tenants: DestroyTreeNode[]): DestroyTreeNode {
	return node({
		name: "prod",
		placement_mode: "dedicated",
		owns_fabric: true,
		waiting_on: tenants.map((t) => ({ name: t.name, status: t.status })),
	});
}

const DEV = node({ name: "dev-1" });
const STAGING = node({ name: "staging", placement_mode: "vcluster" });
const FAILED_STAGING = node({ name: "staging", placement_mode: "vcluster", status: "FAILED" });

/** A control whose tree read resolves to `tree`, with the destroy recorded. */
function control(tree: DestroyTreeNode[]): DestroyEnvironmentControl & {
	destroy: ReturnType<typeof vi.fn<DestroyEnvironmentControl["destroy"]>>;
} {
	return {
		projectName: "shop",
		loadTree: vi.fn(async () => tree),
		destroy: vi.fn<DestroyEnvironmentControl["destroy"]>(async () => {}),
	};
}

/** Renders the Environment settings card in edit mode under `status`. */
function renderCard(c: DestroyEnvironmentControl, status: Partial<EnvironmentStatus> = {}) {
	useCanvasStore.setState({ nodes: [], card: { kind: "env-settings" } });
	return render(
		<EnvironmentStatusProvider value={{ ...EMPTY_ENVIRONMENT_STATUS, ...status }}>
			<EnvSettingsCard destroyEnvironment={c} />
		</EnvironmentStatusProvider>,
	);
}

/** Clicks the danger zone's Destroy and waits for the dialog to finish reading the tree. */
async function openDialog(c: DestroyEnvironmentControl) {
	fireEvent.click(screen.getByRole("button", { name: "Destroy" }));
	await waitFor(() => expect(c.loadTree).toHaveBeenCalled());
	return screen.findByRole("alertdialog");
}

beforeEach(() => {
	useCanvasStore.getState().reset();
});

describe("no live tenants — today's confirm, unchanged", () => {
	it("reads the tree first, then destroys without cascading", async () => {
		const c = control([node({ name: "prod", placement_mode: "dedicated", owns_fabric: true })]);
		renderCard(c);
		const dialog = await openDialog(c);
		expect(within(dialog).getByText("Destroy this environment?")).toBeInTheDocument();
		const confirm = within(dialog).getByRole("button", { name: "Destroy environment" });
		await waitFor(() => expect(confirm).toBeEnabled());
		expect(within(dialog).queryByRole("list")).not.toBeInTheDocument();
		fireEvent.click(confirm);
		expect(c.destroy).toHaveBeenCalledWith({ cascade: false });
	});

	it("holds the destroy button while the tree is still being read", async () => {
		let resolve: (t: DestroyTreeNode[]) => void = () => {};
		const c: DestroyEnvironmentControl = {
			projectName: "shop",
			loadTree: vi.fn(() => new Promise<DestroyTreeNode[]>((r) => (resolve = r))),
			destroy: vi.fn(async () => {}),
		};
		renderCard(c);
		fireEvent.click(screen.getByRole("button", { name: "Destroy" }));
		const dialog = await screen.findByRole("alertdialog");
		expect(within(dialog).getByRole("button", { name: "Destroy environment" })).toBeDisabled();
		await act(async () => resolve([node({ name: "prod" })]));
		expect(within(dialog).getByRole("button", { name: "Destroy environment" })).toBeEnabled();
	});

	it("still lets the user destroy when the tree cannot be read — the server refuses if it must", async () => {
		const c: DestroyEnvironmentControl = {
			projectName: "shop",
			loadTree: vi.fn(async () => {
				throw new Error("boom");
			}),
			destroy: vi.fn(async () => {}),
		};
		renderCard(c);
		const dialog = await openDialog(c);
		expect(await within(dialog).findByText(/couldn.t check whether other environments/i)).toBeInTheDocument();
		expect(within(dialog).getByRole("button", { name: "Destroy environment" })).toBeEnabled();
	});
});

describe("live tenants — the ordered list and two choices", () => {
	const tree = [DEV, STAGING, owner([DEV, STAGING])];

	it("lists every environment in destroy order, each tenant's placement and status, the owner last", async () => {
		const c = control(tree);
		renderCard(c);
		const dialog = await openDialog(c);
		expect(await within(dialog).findByText("Destroy 3 environments?")).toBeInTheDocument();
		const rows = within(
			within(dialog).getByRole("list", { name: /environments that will be destroyed/i }),
		).getAllByRole("listitem");
		expect(rows.map((r) => r.textContent)).toEqual([
			expect.stringMatching(/^1dev-1namespace on the clusterACTIVE$/),
			expect.stringMatching(/^2stagingvcluster on the clusterACTIVE$/),
			expect.stringMatching(/^3prodowns the clusterACTIVE$/),
		]);
		// No plain destroy is offered: the only ways on are children-first or the cascade.
		expect(within(dialog).queryByRole("button", { name: "Destroy environment" })).not.toBeInTheDocument();
	});

	it("'Destroy children first' cancels, destroys nothing, and explains the order with links", async () => {
		const c = control(tree);
		renderCard(c);
		const dialog = await openDialog(c);
		fireEvent.click(await within(dialog).findByRole("button", { name: "Destroy children first" }));
		await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
		expect(c.destroy).not.toHaveBeenCalled();
		expect(screen.getByText(/destroy these environments first/i)).toBeInTheDocument();
		expect(screen.getByRole("link", { name: "dev-1" })).toHaveAttribute(
			"href",
			"?environment_id=env-dev-1&card=env-settings",
		);
		expect(screen.getByRole("link", { name: "staging" })).toHaveAttribute(
			"href",
			"?environment_id=env-staging&card=env-settings",
		);
	});

	it("cascades only once the project name is typed, and then with cascade: true", async () => {
		const c = control(tree);
		renderCard(c);
		const dialog = await openDialog(c);
		const cascade = await within(dialog).findByRole("button", { name: "Destroy all 3 environments" });
		expect(cascade).toBeDisabled();
		const user = userEvent.setup();
		const input = within(dialog).getByRole("textbox");
		await user.type(input, "sho");
		expect(cascade).toBeDisabled();
		await user.type(input, "p");
		await waitFor(() => expect(cascade).toBeEnabled());
		await user.click(cascade);
		await waitFor(() => expect(c.destroy).toHaveBeenCalledWith({ cascade: true }));
		expect(c.destroy).toHaveBeenCalledTimes(1);
	});

	it("asks for the environment's own name when the project's could not be read", async () => {
		const c = { ...control(tree), projectName: null };
		renderCard(c);
		const dialog = await openDialog(c);
		expect(await within(dialog).findByText(/type the environment name/i)).toBeInTheDocument();
		await userEvent.setup().type(within(dialog).getByRole("textbox"), "prod");
		await waitFor(() =>
			expect(within(dialog).getByRole("button", { name: "Destroy all 3 environments" })).toBeEnabled(),
		);
	});
});

describe("a FAILED tenant — called out", () => {
	it("names the failed tenant and both ways out of a held destroy", async () => {
		const c = control([DEV, FAILED_STAGING, owner([DEV, FAILED_STAGING])]);
		renderCard(c);
		const dialog = await openDialog(c);
		const alert = await within(dialog).findByRole("alert");
		expect(alert).toHaveTextContent("staging failed its last run");
		expect(alert).toHaveTextContent(/retry the failed environment.s destroy/i);
		expect(alert).toHaveTextContent(/cancel prod.s destroy job/i);
	});

	it("does not call out a tenant that has not failed", async () => {
		const c = control([DEV, STAGING, owner([DEV, STAGING])]);
		renderCard(c);
		const dialog = await openDialog(c);
		await within(dialog).findByText("Destroy 3 environments?");
		expect(within(dialog).queryByRole("alert")).not.toBeInTheDocument();
	});
});

describe("a held destroy — waiting on its tenants", () => {
	const held: Partial<EnvironmentStatus> = {
		activeJob: { id: "job-9", type: "DESTROY", status: "QUEUED" },
	};

	it("the board's status line reads 'Waiting on <tenant>' instead of 'Running'", async () => {
		const loadTree = vi.fn(async () => [DEV, STAGING, owner([DEV, STAGING])]);
		render(
			<EnvironmentStatusProvider value={{ ...EMPTY_ENVIRONMENT_STATUS, ...held }}>
				<ActivityStatusLine loadDestroyTree={loadTree} />
			</EnvironmentStatusProvider>,
		);
		const line = screen.getByRole("button", { name: /open the activity log/i });
		await waitFor(() => expect(line).toHaveTextContent("Waiting on dev-1 +1"));
		expect(line).not.toHaveTextContent(/running/i);
	});

	it("does not ask while no DESTROY is queued", () => {
		const loadTree = vi.fn(async () => [owner([DEV])]);
		render(
			<EnvironmentStatusProvider
				value={{ ...EMPTY_ENVIRONMENT_STATUS, activeJob: { id: "j", type: "DEPLOY", status: "QUEUED" } }}
			>
				<ActivityStatusLine loadDestroyTree={loadTree} />
			</EnvironmentStatusProvider>,
		);
		expect(loadTree).not.toHaveBeenCalled();
		expect(screen.getByRole("button", { name: /open the activity log/i })).toHaveTextContent(/running/i);
	});

	it("the settings card names a FAILED tenant with its two exits: retry its destroy, or cancel the owner's job", async () => {
		const c = control([DEV, FAILED_STAGING, owner([DEV, FAILED_STAGING])]);
		renderCard(c, held);
		expect(await screen.findByText("Destroy queued, waiting on dev-1 and staging")).toBeInTheDocument();
		expect(screen.getByText("staging failed, so this destroy is held")).toBeInTheDocument();
		expect(screen.getByRole("link", { name: "Retry staging's destroy" })).toHaveAttribute(
			"href",
			"?environment_id=env-staging&card=env-settings",
		);
		expect(screen.getByRole("link", { name: "Cancel this environment's destroy" })).toHaveAttribute(
			"href",
			"/acme/~/jobs/job-9",
		);
	});
});
