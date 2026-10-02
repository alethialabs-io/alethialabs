// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #5365 — the four canvas compat surfaces on a BYO-IaC environment.
//
// The apply gate and the config-time report keep the RAW version for BYO-IaC: the customer's module
// decides it, so the catalog default is a version nobody deploys. The canvas hook used to resolve an
// unset version to that default regardless, so the env alert, the palette badge, the card chip and
// the add-on card could call an add-on compatible or incompatible against it.
//
// The catalog default is pinned BELOW kyverno's window (1.25+) here, so the managed path visibly
// FAILS an unset cluster (proof it still resolves to the default) while the BYO-IaC path must show
// the existing "Unverified" state with the module reason instead. With the real default (1.35) the
// managed path would pass silently and a BYO regression could hide behind the same silence.

import { render, screen } from "@testing-library/react";
import { ReactFlowProvider } from "@xyflow/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/cloud-providers/generated/catalog", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/cloud-providers/generated/catalog")>();
	return { ...actual, DEFAULT_K8S_VERSION: { ...actual.DEFAULT_K8S_VERSION, aws: "1.24" } };
});

const { enableMut, disableMut } = vi.hoisted(() => ({
	enableMut: { mutateAsync: vi.fn(), isPending: false },
	disableMut: { mutateAsync: vi.fn(), isPending: false },
}));
vi.mock("@/lib/query/use-addons-query", () => ({
	useEnableAddon: () => enableMut,
	useDisableAddon: () => disableMut,
	useAddonsQuery: vi.fn(),
}));

import type { AddonMarketItem } from "@/app/server/actions/addons";
import { AddonConfigForm } from "@/components/addons/addon-config-card";
import { CompatAlert } from "@/components/design-project/canvas/inspector/compat-alert";
import { NodePalette } from "@/components/design-project/canvas/node-palette";
import { BaseNode } from "@/components/design-project/canvas/nodes/base-node";
import { useClusterK8sVersion } from "@/components/design-project/canvas/use-cluster-k8s-version";
import {
	EMPTY_ENVIRONMENT_STATUS,
	type EnvironmentStatus,
	type IacEnvironment,
} from "@/lib/canvas/component-status";
import { EnvironmentStatusProvider } from "@/lib/canvas/environment-status-context";
import { BYO_IAC_K8S_VERSION_REASON } from "@/lib/compat";
import { useCanvasStore } from "@/lib/stores/use-canvas-store";

/** An enabled BYO-IaC source, as `getEnvironmentComponentStatus` reports one. */
const IAC: IacEnvironment = {
	source: {
		repoUrl: "https://github.com/acme/infra",
		ref: "main",
		path: "",
		commitSha: "abc123",
		deployedCommitSha: null,
		scanStatus: "done",
		scanOk: true,
		status: "ACTIVE",
		statusMessage: null,
	},
	groups: [],
	costByAddress: {},
	outputs: [],
};

/** The environment's server status: BYO-IaC when `byo`, otherwise a template env. */
function envStatus(byo: boolean): EnvironmentStatus {
	return { ...EMPTY_ENVIRONMENT_STATUS, iac: byo ? IAC : null };
}

/** Seed an aws cluster with `version` ("" = unset) plus a kyverno add-on card (window 1.25+). */
function seed(version: string) {
	useCanvasStore.setState({
		nodes: [
			{
				id: "cluster",
				type: "cluster",
				position: { x: 0, y: 0 },
				data: {
					kind: "cluster" as const,
					config: { cluster_version: version },
					cloud_identity_id: null,
					provider: "aws" as const,
				},
			},
			{
				id: "addon-kyverno",
				type: "addon",
				position: { x: 0, y: 0 },
				data: {
					kind: "addon" as const,
					config: { id: "kyverno", name: "kyverno", version: "3.2.6", namespace: "kyverno" },
					cloud_identity_id: null,
					provider: "aws" as const,
				},
			},
		],
	});
}

/** Render `ui` inside the environment-status provider (and React Flow, for the card). */
function renderIn(byo: boolean, ui: ReactNode) {
	return render(
		<ReactFlowProvider>
			<EnvironmentStatusProvider value={envStatus(byo)}>{ui}</EnvironmentStatusProvider>
		</ReactFlowProvider>,
	);
}

const kyvernoItem: AddonMarketItem = {
	id: "kyverno",
	name: "Kyverno",
	category: "security",
	icon: "ScrollText",
	summary: "Policy engine",
	docsUrl: "https://example.com",
	license: "Apache-2.0",
	chart: "kyverno",
	version: "3.2.6",
	namespace: "kyverno",
	requires: [],
	fields: [],
	install: null,
};

/** The env-settings card's wiring of the alert: the hook's judged version into CompatAlert. */
function EnvAlert() {
	const k8s = useClusterK8sVersion();
	return <CompatAlert provider="aws" k8sVersion={k8s.version} addonIds={["kyverno"]} />;
}

/** The palette, as the canvas opens it in edit mode with one add-on to browse. */
function Palette() {
	return (
		<NodePalette
			open
			onOpenChange={vi.fn()}
			identities={[]}
			addonItems={[kyvernoItem]}
			onConfigureAddon={vi.fn()}
		/>
	);
}

/** The add-on config card's form for kyverno. */
function AddonCard() {
	return (
		<AddonConfigForm
			item={kyvernoItem}
			projectId="p1"
			environmentId="e1"
			hasAppsRepo={false}
			provider="aws"
			onDone={vi.fn()}
		/>
	);
}

beforeEach(() => {
	useCanvasStore.getState().reset();
});

describe("BYO-IaC with an unset cluster version is not_evaluable on every surface", () => {
	it("env alert: silent — no failure judged against the catalog default", () => {
		seed("");
		renderIn(true, <EnvAlert />);
		expect(screen.queryByText(/won't work on this Kubernetes version/i)).not.toBeInTheDocument();
	});

	it("palette badge: Unverified, with the module reason", () => {
		seed("");
		renderIn(true, <Palette />);
		expect(screen.queryByText("K8s 1.25+")).not.toBeInTheDocument();
		expect(screen.getByText("Unverified")).toHaveAttribute("title", BYO_IAC_K8S_VERSION_REASON);
	});

	it("card chip: Unverified, with the module reason", () => {
		seed("");
		renderIn(true, <BaseNode id="addon-kyverno" />);
		expect(screen.queryByText("K8s 1.25+")).not.toBeInTheDocument();
		expect(screen.getByText("Unverified")).toHaveAttribute("title", BYO_IAC_K8S_VERSION_REASON);
	});

	it("add-on card: Unverified, with the module reason", () => {
		seed("");
		renderIn(true, <AddonCard />);
		expect(screen.queryByText("Incompatible")).not.toBeInTheDocument();
		expect(screen.getByText("Unverified")).toBeInTheDocument();
		expect(screen.getByText(BYO_IAC_K8S_VERSION_REASON)).toBeInTheDocument();
	});
});

describe("BYO-IaC with an explicit version judges it as written (as the server does)", () => {
	it("palette badge fails an explicit version below the window", () => {
		seed("1.24");
		renderIn(true, <Palette />);
		expect(screen.getByText("K8s 1.25+")).toBeInTheDocument();
	});
});

describe("the managed path is unchanged: unset resolves to the catalog default", () => {
	it("env alert fails against the default", () => {
		seed("");
		renderIn(false, <EnvAlert />);
		expect(screen.getByText(/won't work on this Kubernetes version/i)).toBeInTheDocument();
	});

	it("palette badge fails against the default", () => {
		seed("");
		renderIn(false, <Palette />);
		expect(screen.getByText("K8s 1.25+")).toBeInTheDocument();
	});

	it("card chip fails against the default", () => {
		seed("");
		renderIn(false, <BaseNode id="addon-kyverno" />);
		expect(screen.getByText("K8s 1.25+")).toBeInTheDocument();
	});

	it("add-on card fails against the default", () => {
		seed("");
		renderIn(false, <AddonCard />);
		expect(screen.getByText("Incompatible")).toBeInTheDocument();
		expect(screen.queryByText(BYO_IAC_K8S_VERSION_REASON)).not.toBeInTheDocument();
	});
});
