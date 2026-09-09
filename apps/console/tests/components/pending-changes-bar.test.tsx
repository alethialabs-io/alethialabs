// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The pending-changes bar's primary button must name the action it performs.
//
// It is hard-wired to "Deploy" in edit mode, where the click persists AND queues provisioning. In
// the create flow the same button runs createProject and queues nothing, so it says "Create
// project" — the label is the only thing telling the two apart.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PendingChangesBar } from "@/components/design-project/canvas/pending-changes-bar";
import { useCanvasStore } from "@/lib/stores/use-canvas-store";

/** The bar only renders when the canvas differs from its baseline — add one node to make it so. */
function stageOneChange() {
	useCanvasStore.getState().reset();
	useCanvasStore.getState().addNode("database");
}

describe("PendingChangesBar", () => {
	beforeEach(() => {
		stageOneChange();
	});

	it("says Deploy by default (edit mode — persists and provisions)", () => {
		render(<PendingChangesBar onDeploy={vi.fn()} />);
		expect(screen.getByRole("button", { name: /^Deploy$/ })).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: /Create project/ })).toBeNull();
	});

	it("says Create project when the create flow passes that label", () => {
		render(<PendingChangesBar onDeploy={vi.fn()} deployLabel="Create project" />);
		expect(
			screen.getByRole("button", { name: /Create project/ }),
		).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: /^Deploy$/ })).toBeNull();
	});
});

describe("PendingChangesBar — save without deploy", () => {
	beforeEach(() => {
		stageOneChange();
	});

	it("offers Save only when the caller can persist without provisioning, and calls it", async () => {
		const onSave = vi.fn();
		render(<PendingChangesBar onDeploy={vi.fn()} onSave={onSave} />);
		await userEvent.setup().click(screen.getByRole("button", { name: /^Save$/ }));
		expect(onSave).toHaveBeenCalledTimes(1);
	});

	it("has no Save in the create flow", () => {
		render(<PendingChangesBar onDeploy={vi.fn()} deployLabel="Create project" />);
		expect(screen.queryByRole("button", { name: /^Save$/ })).toBeNull();
	});
});
