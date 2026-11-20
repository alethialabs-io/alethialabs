// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The Elench surface's load, in each of its states (#6924).
//
// The shell mounts the assistant through `ElenchSurfaceLoader`, which fetches the surface's code
// the first time the assistant is opened. That load had no pending render and no failure render:
// a slow chunk meant "Ask AI" did nothing visible, and a chunk that could not be fetched threw to
// the route's error boundary and replaced the page. The REAL loader is rendered here over the real
// Elench store; the import behind it is the stub (the loader takes it as `load`), and it does what
// each test says: answers, fails, or yields a surface that throws while rendering.

import { act, render, screen } from "@testing-library/react";
import type { ComponentType } from "react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** The surface the stubbed import yields. It throws while rendering for as long as `throws` is set. */
const surface = { throws: false };

/** The stub surface. */
function Surface() {
	if (surface.throws) throw new Error("render failed");
	return <div data-testid="surface">the assistant</div>;
}

// The panel's width constant is read from the real module; its own imports are not needed for that.
vi.mock("@/components/agent/elench/elench-conversation-switcher", () => ({
	ElenchConversationSwitcher: () => null,
}));

import {
	ELENCH_PLACEHOLDER_W,
	ElenchSurfaceLoader,
} from "@/components/agent/elench/elench-surface-loader";
import { ELENCH_PANEL_W } from "@/components/agent/elench/elench-panel";
import { useElenchStore } from "@/lib/stores/use-elench-store";

const INITIAL = useElenchStore.getState();

/** The placeholder the loader draws in the assistant's place, or null. */
function placeholder(): HTMLElement | null {
	return document.querySelector('[data-slot="elench-placeholder"]');
}

/** An import that answers with the stub surface. */
const loads = vi.fn(async (): Promise<ComponentType> => Surface);

beforeEach(() => {
	surface.throws = false;
	loads.mockReset();
	loads.mockImplementation(async () => Surface);
	// React reports a caught render error on the console; that is expected in the last test.
	vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
	useElenchStore.setState(INITIAL, true);
	vi.restoreAllMocks();
});

describe("the Elench surface loader", () => {
	it("draws the placeholder at the docked panel's width", () => {
		expect(ELENCH_PLACEHOLDER_W).toBe(ELENCH_PANEL_W);
	});

	it("draws nothing, and fetches nothing, while the assistant has never been opened", async () => {
		render(<ElenchSurfaceLoader load={loads} />);
		await act(async () => {});
		expect(placeholder()).toBeNull();
		expect(screen.queryByTestId("surface")).toBeNull();
		expect(loads).not.toHaveBeenCalled();
	});

	it("holds the assistant's place from the moment it is opened, then shows the surface there", async () => {
		render(<ElenchSurfaceLoader load={loads} />);
		act(() => useElenchStore.getState().openPanel({ kind: "org" }));
		// Synchronously after the open, before the import has answered: the panel-shaped placeholder.
		const pending = placeholder();
		expect(pending).not.toBeNull();
		expect(pending?.getAttribute("data-view")).toBe("panel");
		expect(pending?.style.width).toBe(`${ELENCH_PANEL_W}px`);
		expect(pending?.querySelector('[data-slot="skeleton-root"]')).toHaveAttribute("aria-busy", "true");
		expect(await screen.findByTestId("surface")).toBeInTheDocument();
		expect(placeholder()).toBeNull();
	});

	it("opened as a modal, the placeholder is an overlay and takes no width from the page", async () => {
		render(<ElenchSurfaceLoader load={loads} />);
		act(() => useElenchStore.getState().openModal({ kind: "org" }));
		expect(placeholder()?.getAttribute("data-view")).toBe("modal");
		expect(placeholder()?.style.width).toBe("");
		expect(await screen.findByTestId("surface")).toBeInTheDocument();
	});

	it("a surface that cannot be fetched says so in the assistant's place, and Try again fetches it", async () => {
		loads.mockRejectedValueOnce(new Error("Loading chunk 4821 failed."));
		const user = userEvent.setup();
		render(<ElenchSurfaceLoader load={loads} />);
		act(() => useElenchStore.getState().openPanel({ kind: "org" }));
		expect(await screen.findByText("Elench could not be loaded")).toBeInTheDocument();
		expect(screen.getByRole("alert")).toHaveAttribute("data-state", "error");
		expect(screen.queryByTestId("surface")).toBeNull();
		expect(loads).toHaveBeenCalledTimes(1);

		// The connection is back: the next attempt asks again and gets the module.
		await user.click(screen.getByRole("button", { name: "Try again" }));
		expect(await screen.findByTestId("surface")).toBeInTheDocument();
		expect(screen.queryByText("Elench could not be loaded")).toBeNull();
		expect(loads).toHaveBeenCalledTimes(2);
	});

	it("Close on the failure closes the assistant, and nothing is left in its place", async () => {
		loads.mockRejectedValue(new Error("Loading chunk 4821 failed."));
		const user = userEvent.setup();
		render(<ElenchSurfaceLoader load={loads} />);
		act(() => useElenchStore.getState().openPanel({ kind: "org" }));
		await screen.findByText("Elench could not be loaded");
		await user.click(screen.getByRole("button", { name: "Close" }));
		expect(useElenchStore.getState().open).toBe(false);
		expect(placeholder()).toBeNull();
	});

	it("a surface that throws while rendering is caught in its own place, with the page left standing", async () => {
		surface.throws = true;
		const user = userEvent.setup();
		render(
			<>
				<p>the page</p>
				<ElenchSurfaceLoader load={loads} />
			</>,
		);
		act(() => useElenchStore.getState().openPanel({ kind: "org" }));
		expect(await screen.findByText("Elench could not be loaded")).toBeInTheDocument();
		expect(screen.getByText("the page")).toBeInTheDocument();

		surface.throws = false;
		await user.click(screen.getByRole("button", { name: "Try again" }));
		expect(await screen.findByTestId("surface")).toBeInTheDocument();
	});
});
