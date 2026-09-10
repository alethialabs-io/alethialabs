// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// A BYO-IaC module in replace mode OWNS the substrate: the cluster's Kubernetes version and the
// VPC come from the module, and a deploy ignores anything staged for them here.
//
// The regression these pin: the guard used to be the toolbar BUTTON, because the button and the
// sheet were one component, so hiding the button unmounted the surface with it. Moving the surface
// onto the rail split them, and the card stayed reachable by two other routes — the Secrets vault's
// "Store · …" row, and the `?card=env-settings` deep link — with the substrate fields editable and
// the deploy quietly discarding them.
//
// The gate is on the SECTIONS rather than on the card, deliberately. Refusing the whole card would
// make that readout do nothing at all, which tells the operator less than showing the settings the
// console still owns and naming who owns the rest.

import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EnvSettingsCard } from "@/components/design-project/canvas/cards/env-settings-card";
import { NODE_REGISTRY } from "@/components/design-project/canvas/graph/node-registry";
import type { CanvasNode } from "@/components/design-project/canvas/graph/types";
import {
	EMPTY_ENVIRONMENT_STATUS,
	type IacEnvironment,
} from "@/lib/canvas/component-status";
import { EnvironmentStatusProvider } from "@/lib/canvas/environment-status-context";
import { PROJECT_NODE_ID, useCanvasStore } from "@/lib/stores/use-canvas-store";

vi.mock("next/navigation", () => ({ useParams: () => ({ org: "acme" }) }));

const GOVERNED: IacEnvironment = {
	source: {
		repoUrl: "https://github.com/acme/infra",
		ref: "main",
		path: "envs/prod",
		commitSha: "abc123",
		deployedCommitSha: "abc123",
		scanStatus: "done",
		scanOk: true,
		status: "ACTIVE",
		statusMessage: null,
	},
	groups: [],
	costByAddress: {},
	outputs: [],
};

function node(kind: "project" | "cluster" | "network"): CanvasNode {
	return {
		id: kind === "project" ? PROJECT_NODE_ID : kind,
		type: kind,
		position: { x: 0, y: 0 },
		data: {
			kind,
			config: NODE_REGISTRY[kind].defaultData("aws"),
			cloud_identity_id: null,
			provider: "aws",
		},
	} as CanvasNode;
}

function renderCard(iac: IacEnvironment | null) {
	useCanvasStore.setState({
		nodes: [node("project"), node("cluster"), node("network")],
		identities: [],
		baseline: [],
		collectionPositions: {},
		card: { kind: "env-settings" },
	});
	return render(
		<EnvironmentStatusProvider value={{ ...EMPTY_ENVIRONMENT_STATUS, iac }}>
			<EnvSettingsCard />
		</EnvironmentStatusProvider>,
	);
}

beforeEach(() => {
	useCanvasStore.getState().reset();
});

describe("environment settings under a BYO-IaC source", () => {
	it("shows the cluster and network sections on a template environment", () => {
		renderCard(null);
		expect(screen.getByText("Cluster")).toBeInTheDocument();
		expect(screen.getByText("Network (VPC)")).toBeInTheDocument();
	});

	it("hides both substrate sections, and says who owns them instead", () => {
		renderCard(GOVERNED);
		expect(screen.queryByText("Cluster")).not.toBeInTheDocument();
		expect(screen.queryByText("Network (VPC)")).not.toBeInTheDocument();
		expect(screen.getByText(/defined by its infrastructure source/i)).toBeInTheDocument();
	});

	it("still opens, so the control that asked the question is not left dead", () => {
		renderCard(GOVERNED);
		expect(screen.getByText("Environment settings")).toBeInTheDocument();
	});
});
