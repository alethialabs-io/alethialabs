// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Every key hint the shell SHOWS is the chord its listener ANSWERS (#6924).
//
// The sidebar's Find box showed `F` long after the bare-F shortcut was removed: the palette
// answered ⌘K only, and the hint was a letter typed beside the button. Hints are now rendered from
// the shortcut registry (`lib/shortcuts/registry.ts`) by `components/shell/shortcut-hint.tsx`.
//
// Two things are held here:
//   1. The hinted controls are RENDERED, and what they show is compared with the registry's row,
//      on both platforms.
//   2. The shell's sources are read for a chord typed by hand.
//
// WHAT (2) RANGES OVER, stated so nobody reads it as more: the `.ts`/`.tsx` files directly in
// `components/shell/` and the three switchers, with comments removed, searched for a modifier
// glyph (⌘ ⌥ ⇧ ⌃) or a spelled modifier joined to a key (`Ctrl+`, `Alt+`, `Cmd+`, `Shift+`,
// `Meta+`). A hint with no modifier in it — a bare letter, which is what the stale `F` was — has no
// shape a search can tell from any other letter, so (1) is what covers the Find box. The comment
// stripping is by regular expression and removes a `//` to the end of its line, so text after a
// URL on the same line is not read.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
	useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
	usePathname: () => "/acme/shop/architecture",
	useSearchParams: () => new URLSearchParams(),
	useParams: () => ({ org: "acme", project: "shop" }),
}));
vi.mock("@/components/environments/new-environment-dialog", () => ({
	NewEnvironmentDialog: () => null,
}));
vi.mock("@/lib/stores/use-elench-store", () => ({
	useElenchStore: { getState: () => ({ syncEnvironment: vi.fn() }) },
}));
vi.mock("@/lib/query/use-projects-query", () => ({
	useProjectsQuery: () => ({
		data: [{ id: "proj_1", slug: "shop", project_name: "Shop", cloud_provider: null }],
	}),
}));

const { EnvSwitcher } = await import("@/components/env-switcher");
const { buildSidebarNav } = await import("@/components/shell/nav-config");
const { ariaKeyShortcuts } = await import("@/components/shell/shortcut-hint");
const { SidebarNav } = await import("@/components/shell/sidebar-nav");
const { orpc } = await import("@/lib/rpc/client");
const { formatChord, getShortcut, SHORTCUT_ENVIRONMENT_NEXT, SHORTCUT_PALETTE_TOGGLE } = await import(
	"@/lib/shortcuts/registry"
);

/** Makes the browser report `platform` until the test ends. */
function onPlatform(platform: string): void {
	Object.defineProperty(navigator, "platform", { value: platform, configurable: true });
}

afterEach(() => {
	Reflect.deleteProperty(navigator, "platform");
});

/** The sidebar's main view, as the shell renders it at org scope. */
function Sidebar() {
	return <SidebarNav groups={buildSidebarNav("acme", { selfRunners: false })} onOpenDrill={() => {}} />;
}

/** The text of the hint rendered for the shortcut `id`, or null when none is on screen. */
function hintFor(id: string): string | null {
	return document.querySelector(`[data-slot="shortcut-hint"][data-shortcut="${id}"]`)?.textContent ?? null;
}

describe("the Find box's key hint", () => {
	it("shows the palette's registered chord as macOS writes it", () => {
		onPlatform("MacIntel");
		render(<Sidebar />);
		const chord = getShortcut(SHORTCUT_PALETTE_TOGGLE).chord;
		expect(hintFor(SHORTCUT_PALETTE_TOGGLE)).toBe(formatChord(chord, true));
		expect(hintFor(SHORTCUT_PALETTE_TOGGLE)).toBe("⌘K");
	});

	it("shows the same chord as other platforms write it", () => {
		onPlatform("Win32");
		render(<Sidebar />);
		const chord = getShortcut(SHORTCUT_PALETTE_TOGGLE).chord;
		expect(hintFor(SHORTCUT_PALETTE_TOGGLE)).toBe(formatChord(chord, false));
		expect(hintFor(SHORTCUT_PALETTE_TOGGLE)).toBe("Ctrl+K");
	});

	it("is not the bare letter the palette stopped answering", () => {
		onPlatform("Win32");
		render(<Sidebar />);
		expect(hintFor(SHORTCUT_PALETTE_TOGGLE)).not.toBe("F");
	});

	it("states the chord to assistive technology on the button itself", () => {
		render(<Sidebar />);
		const find = screen.getByRole("button", { name: /Find/ });
		expect(find).toHaveAttribute(
			"aria-keyshortcuts",
			ariaKeyShortcuts(getShortcut(SHORTCUT_PALETTE_TOGGLE).chord),
		);
		expect(find).toHaveAttribute("aria-keyshortcuts", "Meta+K Control+K");
		// The hint is not part of the button's name: "Find…" is.
		expect(find).toHaveAccessibleName("Find…");
	});

	it("is absent from the server's render, which cannot know the platform", () => {
		expect(renderToString(<Sidebar />)).not.toContain('data-slot="shortcut-hint"');
	});
});

describe("ariaKeyShortcuts", () => {
	it("names both spellings of a ⌘/Ctrl chord, and an Alt chord once", () => {
		expect(ariaKeyShortcuts({ key: "k", mod: true })).toBe("Meta+K Control+K");
		expect(ariaKeyShortcuts({ key: "e", code: "KeyE", alt: true })).toBe("Alt+E");
		expect(ariaKeyShortcuts({ key: "z", mod: true, shift: true })).toBe("Meta+Shift+Z Control+Shift+Z");
		expect(ariaKeyShortcuts({ key: "escape" })).toBe("Escape");
		expect(ariaKeyShortcuts({ key: " " })).toBe("Space");
	});
});

describe("the environment switcher's key hint", () => {
	/** One environment row, as the `[project]` layout's prefetch hydrates it. */
	function env(id: string, name: string, isDefault: boolean) {
		return { id, project_id: "proj_1", name, stage: name, is_default: isDefault };
	}

	/** Renders the switcher over `envs` and opens it. */
	async function openSwitcher(envs: ReturnType<typeof env>[]) {
		const client = new QueryClient();
		client.setQueryData(orpc.workspace.environments.queryKey({ input: { project: "shop" } }), envs);
		render(
			<QueryClientProvider client={client}>
				<EnvSwitcher />
			</QueryClientProvider>,
		);
		const user = userEvent.setup({ delay: null });
		await user.click(screen.getByRole("button", { name: /^Switch environment/ }));
		await screen.findByRole("combobox", { name: "Find environment" });
	}

	it("shows the registered next-environment chord while there is a next environment", async () => {
		onPlatform("MacIntel");
		await openSwitcher([env("env_1", "production", true), env("env_2", "staging", false)]);
		const chord = getShortcut(SHORTCUT_ENVIRONMENT_NEXT).chord;
		expect(hintFor(SHORTCUT_ENVIRONMENT_NEXT)).toBe(formatChord(chord, true));
		expect(hintFor(SHORTCUT_ENVIRONMENT_NEXT)).toBe("⌥E");
	});

	it("shows no chord with one environment, where the shortcut is not bound", async () => {
		await openSwitcher([env("env_1", "production", true)]);
		expect(hintFor(SHORTCUT_ENVIRONMENT_NEXT)).toBeNull();
	});
});

// ── No chord typed by hand ────────────────────────────────────────────────────────────────────

const CONSOLE = join(__dirname, "..", "..", "..");
const SHELL = join(CONSOLE, "components", "shell");

/** The shell's source files: everything directly in `components/shell/`, and the three switchers. */
function shellSources(): string[] {
	const inShell = readdirSync(SHELL)
		.filter((name) => /\.tsx?$/.test(name))
		.map((name) => join(SHELL, name));
	const switchers = ["env-switcher.tsx", "project-switcher.tsx", "org-switcher.tsx"].map((name) =>
		join(CONSOLE, "components", name),
	);
	return [...inShell, ...switchers];
}

/** The source with block comments, JSX comments and `//` comments removed. */
function withoutComments(source: string): string {
	return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

/** A chord as someone would type it: a modifier glyph, or a spelled modifier joined to a key. */
const TYPED_CHORD = /[⌘⌥⇧⌃]|\b(?:Ctrl|Control|Cmd|Alt|Shift|Meta)\s*\+/;

describe("the shell's sources", () => {
	it("are found, so an empty walk cannot pass", () => {
		expect(shellSources().length).toBeGreaterThan(20);
	});

	it("the matcher sees a typed chord, and not a comment or a class list", () => {
		expect(TYPED_CHORD.test(withoutComments("<kbd>⌘K</kbd>"))).toBe(true);
		expect(TYPED_CHORD.test(withoutComments('const hint = "Ctrl+K";'))).toBe(true);
		expect(TYPED_CHORD.test(withoutComments("// opens on ⌘K"))).toBe(false);
		expect(TYPED_CHORD.test(withoutComments("{/* Alt+E switches */}"))).toBe(false);
		expect(TYPED_CHORD.test(withoutComments('<div className="shift-x alt meta" />'))).toBe(false);
	});

	it("type no chord by hand, outside the one file that writes them for aria-keyshortcuts", () => {
		const offenders = shellSources()
			// `shortcut-hint.tsx` builds the `aria-keyshortcuts` value, whose syntax is `Meta+K`.
			.filter((file) => !file.endsWith(join("shell", "shortcut-hint.tsx")))
			.filter((file) => TYPED_CHORD.test(withoutComments(readFileSync(file, "utf8"))))
			.map((file) => file.slice(CONSOLE.length + 1));
		expect(offenders).toEqual([]);
	});
});
