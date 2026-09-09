// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The ⋯ menu is where the toolbar's extras went. What matters: it opens the two cards, hides
// environment settings while a BYO-IaC source governs the env, and its View submenu toggles the
// board's view state through the store.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CanvasMoreMenu } from "@/components/design-project/canvas/canvas-more-menu";
import { useCanvasStore } from "@/lib/stores/use-canvas-store";

vi.mock("@xyflow/react", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@xyflow/react")>();
	return { ...actual, useReactFlow: () => ({ fitView: vi.fn(), zoomIn: vi.fn(), zoomOut: vi.fn() }) };
});

beforeEach(() => {
	useCanvasStore.getState().reset();
	useCanvasStore.setState({ showConnections: true, hiddenKinds: [] });
});

describe("CanvasMoreMenu", () => {
	it("opens the environment-settings and activity cards", async () => {
		const user = userEvent.setup();
		render(<CanvasMoreMenu iacGoverned={false} onShowShortcuts={vi.fn()} />);
		await user.click(screen.getByRole("button", { name: "More" }));
		await user.click(await screen.findByRole("menuitem", { name: /environment settings/i }));
		expect(useCanvasStore.getState().card).toEqual({ kind: "env-settings" });

		await user.click(screen.getByRole("button", { name: "More" }));
		await user.click(await screen.findByRole("menuitem", { name: /^activity$/i }));
		expect(useCanvasStore.getState().card).toEqual({ kind: "activity" });
	});

	it("hides environment settings while a BYO-IaC source governs the environment", async () => {
		const user = userEvent.setup();
		render(<CanvasMoreMenu iacGoverned onShowShortcuts={vi.fn()} />);
		await user.click(screen.getByRole("button", { name: "More" }));
		expect(await screen.findByRole("menuitem", { name: /^activity$/i })).toBeInTheDocument();
		expect(screen.queryByRole("menuitem", { name: /environment settings/i })).not.toBeInTheDocument();
	});

	it("the view toggles write through the store", async () => {
		const user = userEvent.setup();
		render(<CanvasMoreMenu iacGoverned={false} onShowShortcuts={vi.fn()} />);
		await user.click(screen.getByRole("button", { name: "More" }));
		await user.click(await screen.findByRole("menuitemcheckbox", { name: /show connections/i }));
		expect(useCanvasStore.getState().showConnections).toBe(false);
	});

	it("the shortcut entry calls back", async () => {
		const user = userEvent.setup();
		const onShowShortcuts = vi.fn();
		render(<CanvasMoreMenu iacGoverned={false} onShowShortcuts={onShowShortcuts} />);
		await user.click(screen.getByRole("button", { name: "More" }));
		await user.click(await screen.findByRole("menuitem", { name: /keyboard shortcuts/i }));
		expect(onShowShortcuts).toHaveBeenCalledTimes(1);
	});
});
