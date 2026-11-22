// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The inspector on the ENVIRONMENT. Its settings are covered where they always were
// (env-settings-iac, env-secrets-store, destroy-environment-dialog). What is pinned here is that
// it is ONE subject in the inspector's frame: what it says about the environment, which views it
// offers and when, that the views it is handed are drawn inside it, and the way back to a subject
// it was reached from.

import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EnvSettingsCard } from "@/components/design-project/canvas/cards/env-settings-card";
import { NODE_REGISTRY } from "@/components/design-project/canvas/graph/node-registry";
import type { CanvasNode } from "@/components/design-project/canvas/graph/types";
import {
	EMPTY_ENVIRONMENT_STATUS,
	type EnvironmentStatus,
} from "@/lib/canvas/component-status";
import { EnvironmentStatusProvider } from "@/lib/canvas/environment-status-context";
import { board } from "@/lib/canvas/store/board";
import { PROJECT_NODE_ID } from "@/lib/canvas/store/types";
import { setBoardNodes } from "@/tests/fixtures/canvas/board";
import { queryWrapper } from "@/tests/helpers/query-wrapper";

vi.mock("next/navigation", () => ({ useParams: () => ({ org: "acme" }) }));

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

const DEPLOYED: Partial<EnvironmentStatus> = {
	environment: { id: "e1", name: "prod", stage: "production", status: "ACTIVE" },
	deployState: "ahead",
};

/** Renders the environment subject over a project/cluster/network board. */
function renderSubject(
	env: Partial<EnvironmentStatus> = {},
	slots: { sources?: ReactNode; activity?: ReactNode } = {},
) {
	setBoardNodes([node("project"), node("cluster"), node("network")]);
	board.document.getState().replaceBaseline([]);
	board.document.setState({ collectionPositions: {} });
	return render(
		<EnvironmentStatusProvider value={{ ...EMPTY_ENVIRONMENT_STATUS, ...env }}>
			<EnvSettingsCard {...slots} />
		</EnvironmentStatusProvider>,
		{ wrapper: queryWrapper() },
	);
}

/** The labels of the tabs on screen, in order. */
const tabs = () => screen.getAllByRole("tab").map((tab) => tab.textContent);

beforeEach(() => {
	board.reset();
});

describe("the environment subject", () => {
	it("says which environment it is, and where it stands against the last deploy", () => {
		renderSubject(DEPLOYED);
		expect(screen.getByRole("heading", { level: 2, name: "Environment settings" })).toBeInTheDocument();
		expect(screen.getByText("prod · production")).toBeInTheDocument();
		expect(screen.getByText("Active")).toBeInTheDocument();
		expect(screen.getByText("The saved design is ahead of what is deployed.")).toBeInTheDocument();
	});

	it("says a refusal to deploy in the status row, ahead of the deploy state", () => {
		renderSubject({
			...DEPLOYED,
			deployRefusal: {
				reason: "cloud-not-offered",
				message: "This environment's cloud is not offered.",
			},
		});
		expect(screen.getByText("This environment's cloud is not offered.")).toBeInTheDocument();
		expect(
			screen.queryByText("The saved design is ahead of what is deployed."),
		).not.toBeInTheDocument();
	});

	it("opens on Settings and offers only the views it can fill", () => {
		renderSubject();
		expect(tabs()).toEqual(["Settings", "Status"]);
		expect(screen.getByRole("tab", { name: "Settings" })).toHaveAttribute("aria-selected", "true");
		expect(screen.getByText("Cluster")).toBeInTheDocument();
	});

	it("draws the Sources and Activity views it is handed, inside its own frame", async () => {
		const user = userEvent.setup();
		renderSubject(DEPLOYED, { sources: <p>the sources</p>, activity: <p>the activity</p> });
		expect(tabs()).toEqual(["Settings", "Sources", "Status", "Activity"]);

		await user.click(screen.getByRole("tab", { name: "Sources" }));
		expect(screen.getByText("the sources")).toBeInTheDocument();
		expect(screen.queryByText("Cluster")).not.toBeInTheDocument();

		await user.click(screen.getByRole("tab", { name: "Activity" }));
		expect(screen.getByText("the activity")).toBeInTheDocument();
		// One frame: still one heading for the subject and one close control.
		expect(screen.getAllByRole("heading", { level: 2 })).toHaveLength(1);
		expect(screen.getAllByRole("button", { name: "Close" })).toHaveLength(1);
	});

	it("opens on the view the store asks for, and falls back to Settings when it has none", () => {
		act(() => board.view.getState().setSubject({ kind: "environment" }, "activity"));
		const view = renderSubject(DEPLOYED, { activity: <p>the activity</p> });
		expect(screen.getByText("the activity")).toBeInTheDocument();
		view.unmount();

		act(() => board.view.getState().setSubject({ kind: "environment" }, "activity"));
		renderSubject(DEPLOYED);
		expect(screen.getByRole("tab", { name: "Settings" })).toHaveAttribute("aria-selected", "true");
	});

	it("Status shows the environment, and what is running against it now", async () => {
		const user = userEvent.setup();
		renderSubject({
			...DEPLOYED,
			activeJob: { id: "j1", type: "DEPLOY", status: "PROCESSING" },
		});
		await user.click(screen.getByRole("tab", { name: "Status" }));
		expect(screen.getByRole("heading", { name: "Running now" })).toBeInTheDocument();
		expect(screen.getByText("Deploy")).toBeInTheDocument();
		expect(screen.getByRole("heading", { name: "Delivery" })).toBeInTheDocument();
	});

	it("has no commit button: nothing is named Save, Install or Update", () => {
		renderSubject(DEPLOYED);
		const names = screen
			.getAllByRole("button")
			.map((button) => (button.getAttribute("aria-label") ?? button.textContent ?? "").trim());
		expect(names.filter((name) => /^(save|install|update)\b/i.test(name))).toEqual([]);
	});

	it("offers the way back to the subject it was reached from", async () => {
		const user = userEvent.setup();
		act(() => {
			board.view.getState().setSubject({ kind: "collection", nodeKind: "secret" });
			board.view.getState().openCard({ kind: "env-settings" }, { back: true });
		});
		renderSubject(DEPLOYED);
		await user.click(screen.getByRole("button", { name: "Back" }));
		expect(board.view.getState().subject).toEqual({ kind: "collection", nodeKind: "secret" });
	});

	it("offers no way back when it was opened directly", () => {
		act(() => board.view.getState().setSubject({ kind: "environment" }));
		renderSubject(DEPLOYED);
		expect(screen.queryByRole("button", { name: "Back" })).not.toBeInTheDocument();
	});
});
