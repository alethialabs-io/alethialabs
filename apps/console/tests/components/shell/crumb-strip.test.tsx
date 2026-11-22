// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The page is named below 768px (#6924, R6 S-05).
//
// The console has no page titles; the breadcrumb names the page. The breadcrumb's box in the
// topbar was `hidden md:flex`, so on a phone, with the navigation drawer closed, nothing on screen
// said which page it was. The same box is now a strip under the header below `md`, showing its last
// crumb.
//
// WHAT THIS CAN AND CANNOT SEE. jsdom applies no stylesheet and evaluates no media query, so
// nothing here measures the strip. What is held is the markup the layout depends on: the box is no
// longer hidden at any width, it is ONE breadcrumb and not a second copy for small screens, the
// rule that hides every crumb but the last is on it, and every route in the shell has a last crumb
// to show. How it looks at 400px is for a person to check; the PR says so.

import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { pathname } = vi.hoisted(() => ({ pathname: { current: "/acme/~/settings/general" } }));

vi.mock("next/navigation", () => ({ usePathname: () => pathname.current }));
vi.mock("@/lib/stores/use-workspace-store", () => ({ useActiveWorkspaceOrg: () => null }));
vi.mock("@/lib/query/use-jobs-query", () => ({ useRecentJobsQuery: () => ({ data: [] }) }));
vi.mock("@/lib/query/use-support-cases-query", () => ({
	useSupportCasesQuery: () => ({ data: [] }),
}));
vi.mock("@/components/project-switcher", () => ({ ProjectSwitcher: () => null }));
vi.mock("@/components/env-switcher", () => ({ EnvSwitcher: () => null }));
vi.mock("@/components/onboarding/setup-guide", () => ({ SetupGuideButton: () => null }));
vi.mock("@/components/download-cli-button", () => ({ DownloadCliButton: () => null }));
vi.mock("@/components/shell/ask-ai-button", () => ({ AskAiButton: () => null }));

const { buildCrumbs } = await import("@/components/shell/breadcrumb-trail");
const { CRUMB_BOX, CRUMB_STRIP_VARS, MAIN_COLUMN_VARS, MAIN_UNDER_CRUMB_STRIP } = await import(
	"@/components/shell/crumb-strip"
);
const { Topbar } = await import("@/components/shell/topbar");

/** The breadcrumb's box in the topbar. */
function crumbBox(container: HTMLElement): HTMLElement {
	const box = container.querySelector<HTMLElement>('[data-slot="topbar-crumbs"]');
	if (box === null) throw new Error("the topbar rendered no breadcrumb box");
	return box;
}

beforeEach(() => {
	pathname.current = "/acme/~/settings/general";
});

describe("the topbar's breadcrumb box", () => {
	it("is not hidden at any width: no `hidden` class, with or without a breakpoint in front", () => {
		const { container } = render(<Topbar onOpenSidebar={() => {}} />);
		const hiding = Array.from(crumbBox(container).classList).filter(
			(cls) => cls === "hidden" || cls.endsWith(":hidden"),
		);
		// Two classes end in `:hidden` and neither hides the box: `empty:hidden` (a box with no
		// trail), and the rule that hides the crumbs before the last one, below `md`.
		expect(hiding.sort()).toEqual(["empty:hidden", "max-md:[&_li:not(:last-child)]:hidden"]);
	});

	it("holds the one breadcrumb, whose last crumb is the current page", () => {
		const { container } = render(<Topbar onOpenSidebar={() => {}} />);
		expect(screen.getAllByRole("navigation", { name: "breadcrumb" })).toHaveLength(1);
		const trail = within(crumbBox(container)).getByRole("navigation", { name: "breadcrumb" });
		const items = within(trail).getAllByRole("listitem");
		const last = items[items.length - 1];
		expect(last.textContent).toBe("General");
		expect(last.querySelector('[aria-current="page"]')).not.toBeNull();
		// The last `<li>` of the list is the current page, which is what `li:not(:last-child)` keeps.
		expect(last.parentElement?.lastElementChild).toBe(last);
	});

	it("is the header's own child for positioning: the header is the strip's containing block", () => {
		const { container } = render(<Topbar onOpenSidebar={() => {}} />);
		expect(container.querySelector("header")?.classList.contains("relative")).toBe(true);
		expect(crumbBox(container).classList.contains("max-md:absolute")).toBe(true);
	});
});

describe("the strip's height", () => {
	it("is one variable, read by the strip, by <main>'s offset and by <main>'s re-stated header height", () => {
		expect(CRUMB_STRIP_VARS).toBe("[--shell-crumb-h:2rem]");
		expect(CRUMB_BOX.split(" ")).toContain("max-md:h-(--shell-crumb-h)");
		expect(MAIN_UNDER_CRUMB_STRIP.split(" ")).toContain("max-md:mt-(--shell-crumb-h)");
		expect(MAIN_UNDER_CRUMB_STRIP.split(" ")).toContain(
			"max-md:[--shell-header-h:calc(var(--shell-topbar-h)+var(--shell-crumb-h))]",
		);
		// `<main>` re-states `--shell-header-h`, so the header's own height is recorded one level up
		// under a second name. A property defined in terms of itself is invalid.
		expect(MAIN_COLUMN_VARS).toBe("[--shell-topbar-h:var(--shell-header-h)]");
	});

	it("changes nothing from `md` up: every class that moves the box or <main> is below `md`", () => {
		const moving = [...CRUMB_BOX.split(" "), ...MAIN_UNDER_CRUMB_STRIP.split(" ")].filter(
			(cls) => /absolute|inset|top-|mt-|border|bg-|px-|h-\(|--shell-header-h/.test(cls),
		);
		expect(moving.length).toBeGreaterThan(0);
		expect(moving.filter((cls) => !cls.startsWith("max-md:"))).toEqual([]);
	});
});

describe("every route in the shell has a page to name", () => {
	it("builds at least one crumb for the org overview, the org-wide pages and the project views", () => {
		const routes = [
			"/acme",
			"/acme/~/jobs",
			"/acme/~/jobs/3f2b1c9e-0000-4000-8000-000000000001",
			"/acme/~/settings/general",
			"/acme/~/support/cases/3f2b1c9e-0000-4000-8000-000000000002",
			"/acme/shop",
			"/acme/shop/architecture",
			"/acme/shop/jobs",
			"/acme/shop/settings/general",
		];
		expect(routes.filter((route) => buildCrumbs(route).length === 0)).toEqual([]);
	});
});
