// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The Secrets vault, rendered. A project with 30 secrets must not become 30 cards — but collapsing
// them must not hide anything either: a failed secret has to be visible from the card AND findable
// in the list, and you must still be able to open and configure any single one.

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ReactFlowProvider } from "@xyflow/react";
import { beforeEach, describe, expect, it } from "vitest";
import { CollectionNode } from "@/components/design-project/canvas/nodes/collection-node";
import { CollectionPanel } from "@/components/design-project/canvas/inspector/collection-panel";
import { NODE_REGISTRY } from "@/components/design-project/canvas/graph/node-registry";
import { collectionNodeId } from "@/lib/canvas/collections";
import {
	EMPTY_ENVIRONMENT_STATUS,
	type ComponentServerStatus,
	type EnvironmentStatus,
} from "@/lib/canvas/component-status";
import { EnvironmentStatusProvider } from "@/lib/canvas/environment-status-context";
import type { CanvasNode } from "@/components/design-project/canvas/graph/types";
import type { ComponentStatus } from "@/lib/db/schema/enums";
import { PROJECT_NODE_ID, useCanvasStore } from "@/lib/stores/use-canvas-store";

/** N secrets in the store, plus the project root. */
function seedSecrets(names: string[]) {
	const root = {
		id: PROJECT_NODE_ID,
		type: "project",
		position: { x: 0, y: 0 },
		data: {
			kind: "project",
			config: NODE_REGISTRY.project.defaultData("aws"),
			cloud_identity_id: null,
			provider: "aws",
		},
	} as CanvasNode;

	const secrets = names.map(
		(name) =>
			({
				id: `secret-${name}`,
				type: "secret",
				position: { x: 0, y: 0 },
				data: {
					kind: "secret",
					config: { ...NODE_REGISTRY.secret.defaultData("aws"), name },
					cloud_identity_id: null,
					provider: "aws",
				},
			}) as CanvasNode,
	);

	useCanvasStore.setState({
		nodes: [root, ...secrets],
		identities: [],
		baseline: [],
		collectionPositions: {},
	});
	return secrets;
}

const status = (
	lifecycle: ComponentStatus,
	overrides: Partial<ComponentServerStatus> = {},
): ComponentServerStatus => ({ lifecycle, message: null, drift: [], ...overrides });

function renderVault(memberIds: string[], env?: Partial<EnvironmentStatus>) {
	return render(
		<ReactFlowProvider>
			<EnvironmentStatusProvider value={{ ...EMPTY_ENVIRONMENT_STATUS, ...env }}>
				<CollectionNode
					id={collectionNodeId("secret")}
					type="collection"
					data={{ kind: "secret", memberIds }}
					selected={false}
					dragging={false}
					draggable
					selectable
					deletable={false}
					zIndex={0}
					isConnectable
					positionAbsoluteX={0}
					positionAbsoluteY={0}
				/>
			</EnvironmentStatusProvider>
		</ReactFlowProvider>,
	);
}

function renderPanel(env?: Partial<EnvironmentStatus>) {
	return render(
		<EnvironmentStatusProvider value={{ ...EMPTY_ENVIRONMENT_STATUS, ...env }}>
			<CollectionPanel kind="secret" />
		</EnvironmentStatusProvider>,
	);
}

beforeEach(() => {
	useCanvasStore.getState().reset();
});

describe("the vault card", () => {
	it("stands in for every secret — thirty resources, one card, one count", () => {
		const secrets = seedSecrets(
			Array.from({ length: 30 }, (_, i) => `secret-${i}`),
		);
		renderVault(secrets.map((s) => s.id));

		expect(screen.getByText("Secrets")).toBeInTheDocument();
		expect(screen.getByText("30")).toBeInTheDocument();
		expect(screen.getByText("secrets")).toBeInTheDocument();
	});

	it("previews a few names and says how many more, rather than printing all thirty", () => {
		const secrets = seedSecrets(["alpha", "beta", "gamma", "delta", "epsilon", "zeta"]);
		renderVault(secrets.map((s) => s.id));

		expect(screen.getByText("alpha")).toBeInTheDocument();
		// The whole point is NOT to render them all — the panel is for that.
		expect(screen.queryByText("zeta")).not.toBeInTheDocument();
		expect(screen.getByText("+2 more")).toBeInTheDocument();
	});

	it("uses the singular when it holds one", () => {
		const secrets = seedSecrets(["only"]);
		renderVault(secrets.map((s) => s.id));
		expect(screen.getByText("secret")).toBeInTheDocument();
	});

	// The guarantee that makes collapsing safe.
	it("reports its WORST member — one failed secret and the vault is not Live", () => {
		const secrets = seedSecrets(["ok-1", "broken", "ok-2"]);
		renderVault(
			secrets.map((s) => s.id),
			{
				components: {
					"secret:ok-1": status("ACTIVE"),
					"secret:broken": status("FAILED", { message: "access denied" }),
					"secret:ok-2": status("ACTIVE"),
				},
			},
		);

		expect(screen.getByText("Failed")).toBeInTheDocument();
	});

	it("stays calm when every member is healthy", () => {
		const secrets = seedSecrets(["a", "b"]);
		renderVault(
			secrets.map((s) => s.id),
			{
				components: { "secret:a": status("ACTIVE"), "secret:b": status("ACTIVE") },
			},
		);
		expect(screen.queryByText("Failed")).not.toBeInTheDocument();
		expect(screen.queryByText("Needs setup")).not.toBeInTheDocument();
	});

	it("surfaces drift across its members", () => {
		const secrets = seedSecrets(["a", "b"]);
		renderVault(
			secrets.map((s) => s.id),
			{
				components: {
					"secret:a": status("ACTIVE", {
						drift: [
							{
								address: "aws_secretsmanager_secret.a",
								type: "aws_secretsmanager_secret",
								kind: "modified",
							},
						],
					}),
					"secret:b": status("ACTIVE"),
				},
			},
		);
		expect(screen.getByText("1 drifted")).toBeInTheDocument();
	});
});

describe("the vault's panel — where the secrets actually live", () => {
	it("lists every secret (this is the list the card deliberately doesn't print)", () => {
		seedSecrets(["alpha", "beta", "gamma"]);
		renderPanel();

		expect(screen.getByText("alpha")).toBeInTheDocument();
		expect(screen.getByText("beta")).toBeInTheDocument();
		expect(screen.getByText("gamma")).toBeInTheDocument();
	});

	it("shows a broken secret's state in the list, so trouble is findable", () => {
		seedSecrets(["ok", "broken"]);
		renderPanel({
			components: {
				"secret:ok": status("ACTIVE"),
				"secret:broken": status("FAILED", { message: "access denied" }),
			},
		});
		expect(screen.getByText("Failed")).toBeInTheDocument();
	});

	it("filters — a vault with forty entries needs one, or the list is as bad as the cards", async () => {
		const user = userEvent.setup();
		seedSecrets(["stripe-api-key", "db-password", "stripe-webhook"]);
		renderPanel();

		await user.type(screen.getByPlaceholderText("Filter secrets…"), "stripe");

		expect(screen.getByText("stripe-api-key")).toBeInTheDocument();
		expect(screen.getByText("stripe-webhook")).toBeInTheDocument();
		expect(screen.queryByText("db-password")).not.toBeInTheDocument();
	});

	it("opens a single secret's own inspector — collapsing never takes away configuring one", async () => {
		const user = userEvent.setup();
		const secrets = seedSecrets(["stripe-api-key"]);
		renderPanel();

		await user.click(screen.getByText("stripe-api-key"));

		expect(useCanvasStore.getState().inspectorNodeId).toBe(secrets[0].id);
	});

	it("adds a secret", async () => {
		const user = userEvent.setup();
		seedSecrets(["existing"]);
		renderPanel();

		await user.click(screen.getByRole("button", { name: "Add" }));

		const secrets = useCanvasStore
			.getState()
			.nodes.filter((n) => n.data.kind === "secret");
		expect(secrets).toHaveLength(2);
	});

	it("removes one", async () => {
		const user = userEvent.setup();
		seedSecrets(["doomed", "keeper"]);
		renderPanel();

		await user.click(screen.getByRole("button", { name: "Remove doomed" }));

		const names = useCanvasStore
			.getState()
			.nodes.filter((n) => n.data.kind === "secret")
			.map((n) => (n.data.config as { name?: string }).name);
		expect(names).toEqual(["keeper"]);
	});

	it("says so when it's empty", () => {
		seedSecrets([]);
		renderPanel();
		expect(screen.getByText(/No secrets yet/i)).toBeInTheDocument();
	});

	it("says so when a filter matches nothing", async () => {
		const user = userEvent.setup();
		seedSecrets(["alpha"]);
		renderPanel();

		await user.type(screen.getByPlaceholderText("Filter secrets…"), "zzz");
		expect(screen.getByText(/No secret matches/i)).toBeInTheDocument();
	});
});
