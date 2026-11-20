// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The shell's two shortcuts, through the REAL components that own them (#6758).
//
// The environment switcher used to take Shift+Tab on `window` with `preventDefault`, on every
// project page that had two or more environments, so reverse focus traversal stopped working from
// every element that was not a field. It now answers ⌥E / Alt+E, and Shift+Tab is the browser's.
// The command palette used to open on a bare F as well as ⌘K; a bare letter is no longer a shell
// shortcut.
//
// The switcher and the palette are rendered as they are; only navigation, the queries behind them
// and the assistant store are stubbed. `fireEvent.keyDown` returns `false` exactly when
// `preventDefault` was called, which is how "the browser keeps this key" is asserted.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { push, syncEnvironment } = vi.hoisted(() => ({
	push: vi.fn(),
	syncEnvironment: vi.fn(),
}));

vi.mock("next/navigation", () => ({
	useRouter: () => ({ push, refresh: vi.fn(), replace: vi.fn() }),
	// The Architecture view: the one project view that shows a single environment, and so the one
	// the switcher and its shortcut are on (#6924).
	usePathname: () => "/acme/shop/architecture",
	useSearchParams: () => new URLSearchParams(),
	useParams: () => ({ org: "acme", project: "shop" }),
}));
vi.mock("@/components/environments/new-environment-dialog", () => ({
	NewEnvironmentDialog: () => null,
}));
vi.mock("@/lib/stores/use-elench-store", () => ({
	useElenchStore: { getState: () => ({ syncEnvironment }) },
}));
vi.mock("@/lib/stores/use-workspace-store", () => ({
	useActiveOrgSlug: () => "acme",
}));
vi.mock("@/lib/query/use-projects-query", () => ({
	useProjectsQuery: () => ({
		data: [{ id: "proj_1", slug: "shop", project_name: "Shop", cloud_provider: null }],
	}),
}));
vi.mock("@/lib/query/use-jobs-query", () => ({
	useRecentJobsQuery: () => ({ data: [] }),
}));

const { EnvSwitcher } = await import("@/components/env-switcher");
const { CommandPalette } = await import("@/components/shell/command-palette");
const { useCommandPalette } = await import("@/lib/stores/use-command-palette");
const { orpc } = await import("@/lib/rpc/client");

/** One environment row, as the `[project]` layout's prefetch hydrates it. */
function env(id: string, name: string, isDefault: boolean) {
	return { id, project_id: "proj_1", name, stage: name, is_default: isDefault };
}

/** Renders the switcher over the given environments, with a field and a button beside it. */
function renderSwitcher(envs: ReturnType<typeof env>[]) {
	const client = new QueryClient();
	client.setQueryData(
		orpc.workspace.environments.queryKey({ input: { project: "shop" } }),
		envs,
	);
	return render(
		<QueryClientProvider client={client}>
			<EnvSwitcher />
			<button type="button">a page button</button>
			<input aria-label="a field" />
		</QueryClientProvider>,
	);
}

const TWO_ENVS = [env("env_1", "production", true), env("env_2", "staging", false)];

/** The ⌥E / Alt+E press. macOS reports a dead key for it, so the physical key is what identifies it. */
const NEXT_ENV = { key: "Dead", code: "KeyE", altKey: true };

beforeEach(() => {
	push.mockClear();
	syncEnvironment.mockClear();
	act(() => useCommandPalette.getState().setOpen(false));
});

describe("the environment switcher", () => {
	it("leaves Shift+Tab to the browser and does not switch environment", () => {
		renderSwitcher(TWO_ENVS);
		const pageButton = screen.getByRole("button", { name: "a page button" });
		expect(fireEvent.keyDown(pageButton, { key: "Tab", code: "Tab", shiftKey: true })).toBe(
			true,
		);
		expect(
			fireEvent.keyDown(document.body, { key: "Tab", code: "Tab", shiftKey: true }),
		).toBe(true);
		expect(push).not.toHaveBeenCalled();
		expect(syncEnvironment).not.toHaveBeenCalled();
	});

	it("switches to the next environment on the modifier chord, and re-scopes the assistant", () => {
		renderSwitcher(TWO_ENVS);
		const pageButton = screen.getByRole("button", { name: "a page button" });
		expect(fireEvent.keyDown(pageButton, NEXT_ENV)).toBe(false);
		expect(push).toHaveBeenCalledTimes(1);
		expect(push).toHaveBeenCalledWith("/acme/shop/architecture?environment_id=env_2");
		expect(syncEnvironment).toHaveBeenCalledWith("proj_1", "env_2");
	});

	it("does not switch while the focus is in a field", () => {
		renderSwitcher(TWO_ENVS);
		const field = screen.getByRole("textbox", { name: "a field" });
		expect(fireEvent.keyDown(field, NEXT_ENV)).toBe(true);
		expect(push).not.toHaveBeenCalled();
	});

	it("does not answer the bare letter, or the chord with Shift added", () => {
		renderSwitcher(TWO_ENVS);
		const pageButton = screen.getByRole("button", { name: "a page button" });
		expect(fireEvent.keyDown(pageButton, { key: "e", code: "KeyE" })).toBe(true);
		expect(fireEvent.keyDown(pageButton, { ...NEXT_ENV, shiftKey: true })).toBe(true);
		expect(push).not.toHaveBeenCalled();
	});

	it("with one environment, leaves the chord to the browser", () => {
		renderSwitcher([env("env_1", "production", true)]);
		const pageButton = screen.getByRole("button", { name: "a page button" });
		expect(fireEvent.keyDown(pageButton, NEXT_ENV)).toBe(true);
		expect(push).not.toHaveBeenCalled();
	});
});

describe("the command palette", () => {
	/** Renders the palette with a field and a button on the page behind it. */
	function renderPalette() {
		return render(
			<>
				<CommandPalette />
				<button type="button">a page button</button>
				<input aria-label="a field" />
			</>,
		);
	}

	it("opens on ⌘K and on Ctrl+K", () => {
		renderPalette();
		const pageButton = screen.getByRole("button", { name: "a page button" });
		expect(fireEvent.keyDown(pageButton, { key: "k", metaKey: true })).toBe(false);
		expect(useCommandPalette.getState().open).toBe(true);
		act(() => useCommandPalette.getState().setOpen(false));
		expect(fireEvent.keyDown(pageButton, { key: "k", ctrlKey: true })).toBe(false);
		expect(useCommandPalette.getState().open).toBe(true);
	});

	it("opens on ⌘K while the focus is in a field", () => {
		renderPalette();
		const field = screen.getByRole("textbox", { name: "a field" });
		expect(fireEvent.keyDown(field, { key: "k", metaKey: true })).toBe(false);
		expect(useCommandPalette.getState().open).toBe(true);
	});

	it("does not open on a bare F, and the key is left to the page", () => {
		renderPalette();
		const pageButton = screen.getByRole("button", { name: "a page button" });
		expect(fireEvent.keyDown(pageButton, { key: "f" })).toBe(true);
		expect(fireEvent.keyDown(document.body, { key: "F", shiftKey: true })).toBe(true);
		expect(useCommandPalette.getState().open).toBe(false);
	});

	it("leaves Shift+Tab to the browser", () => {
		renderPalette();
		expect(
			fireEvent.keyDown(document.body, { key: "Tab", code: "Tab", shiftKey: true }),
		).toBe(true);
		expect(useCommandPalette.getState().open).toBe(false);
	});
});
