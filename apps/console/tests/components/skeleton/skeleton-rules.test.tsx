// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// "The skeleton rules" (docs/ui-conformance/RUBRIC.md; CON-SM7, #6759) — the three of the five
// that a test can hold:
//
//   1. one root, and it is `SkeletonRoot` — rendered here, so the wrapper's one statement
//      (`aria-busy`, never `aria-hidden`) is pinned and a caller cannot unsay it;
//   4. a skeleton is synchronous — an async `loading.tsx` is banned (decision CON-M4);
//   5. a skeleton is never a spinner.
//
// Rules 4 and 5 are read off every `loading.tsx` under `app/`. The files that break either rule
// today are carried as two ledgers, each owned by the lane whose scope holds the file. A ledger
// fails in BOTH directions: a file that breaks a rule and is not listed fails, and so does an
// entry whose file no longer breaks it — so a list cannot outlive what it excuses, and fixing a
// route moves a line here in the same diff.
//
// WHAT THE MATCHERS READ, AND WHAT THEY DO NOT. Rule 4 is the tokens `async` and `await` anywhere
// in the file outside a block comment or a whole-line `//` comment. A synchronous `loading.tsx`
// that suspends through React's `use()` is the same defect and is NOT matched. Rule 5 is the class
// token `animate-spin` in the `loading.tsx` itself; a spinner inside a component the file renders
// is NOT matched. Neither reads a skeleton that is not a `loading.tsx` (a panel's own pending
// render), and nothing here checks that an existing skeleton's root is `SkeletonRoot`.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { render, screen } from "@testing-library/react";
import { isValidElement } from "react";
import { describe, expect, it } from "vitest";

import ProjectArchitectureLoading from "@/app/(private)/[org]/[project]/architecture/loading";
import ProjectLoading from "@/app/(private)/[org]/[project]/loading";
import { BoardPreview } from "@/components/design-project/canvas/board-preview";
import { CanvasSkeleton } from "@/components/design-project/canvas/canvas-skeleton";
import { SkeletonRoot } from "@/components/skeleton/skeleton-root";

const CONSOLE = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const APP = join(CONSOLE, "app");

/**
 * Async `loading.tsx` files, each with the issue whose scope holds it. Keyed by path relative to
 * apps/console. No route was migrated by the unit that wrote this list. Empty since #7236 made the
 * case-detail route's synchronous; the ledger stays so a new async one has to be listed against an
 * issue to pass.
 */
const OWED_ASYNC: Record<string, string> = {};

/**
 * Spinner `loading.tsx` files. Empty since #7010 replaced the last one; the ledger stays so a new
 * spinner has to be listed against an issue to pass.
 */
const OWED_SPINNER: Record<string, string> = {};

/** Every `loading.tsx` under `dir`, recursively. */
function walk(dir: string): string[] {
	const out: string[] = [];
	for (const name of readdirSync(dir)) {
		const p = join(dir, name);
		if (statSync(p).isDirectory()) out.push(...walk(p));
		else if (name === "loading.tsx") out.push(p);
	}
	return out;
}

/** The source with block comments and whole-line `//` comments removed, so prose cannot match. */
function withoutComments(source: string): string {
	return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** Does this source declare or await anything asynchronous? */
function isAsync(source: string): boolean {
	return /\b(async|await)\b/.test(withoutComments(source));
}

/** Does this source draw a spinner? */
function isSpinner(source: string): boolean {
	return /(^|[\s"'`:])animate-spin(?![\w-])/.test(withoutComments(source));
}

/** Console-relative, forward-slashed paths of the `loading.tsx` files `test` is true of. */
function matching(test: (source: string) => boolean): string[] {
	return walk(APP)
		.filter((f) => test(readFileSync(f, "utf8")))
		.map((f) => relative(CONSOLE, f).split(sep).join("/"))
		.sort();
}

describe("the matchers can fire, and can stay quiet", () => {
	it("reads an async default export and a bare await", () => {
		expect(isAsync("export default async function Loading() { return null; }")).toBe(true);
		expect(isAsync("export default function Loading() { const x = await read(); return x; }")).toBe(true);
	});

	it("does not read the word in a comment, or inside another identifier", () => {
		expect(isAsync("// this used to be async and await a read\nexport default function Loading() { return null; }")).toBe(false);
		expect(isAsync("/** Not async. */\nexport default function Loading() { return null; }")).toBe(false);
		expect(isAsync("export default function Loading() { return <AsyncBoundary awaited />; }")).toBe(false);
	});

	it("reads a spinner class, with or without a variant prefix", () => {
		expect(isSpinner('<div className="h-6 w-6 animate-spin rounded-full" />')).toBe(true);
		expect(isSpinner('<div className="motion-safe:animate-spin" />')).toBe(true);
	});

	it("does not read a pulse, or a longer class that starts the same way", () => {
		expect(isSpinner('<div className="animate-pulse" />')).toBe(false);
		expect(isSpinner('<div className="animate-spin-slow" />')).toBe(false);
	});
});

describe("loading.tsx", () => {
	const files = walk(APP);

	it("finds the console's loading files, so an empty walk cannot pass", () => {
		expect(files.length).toBeGreaterThan(20);
	});

	it("is synchronous everywhere but the owed files", () => {
		expect(matching(isAsync).filter((f) => !(f in OWED_ASYNC))).toEqual([]);
	});

	it("lists no async file that has already been made synchronous", () => {
		const found = matching(isAsync);
		expect(Object.keys(OWED_ASYNC).filter((f) => !found.includes(f))).toEqual([]);
	});

	it("is a spinner nowhere but the owed files", () => {
		expect(matching(isSpinner).filter((f) => !(f in OWED_SPINNER))).toEqual([]);
	});

	it("lists no spinner that has already been replaced", () => {
		const found = matching(isSpinner);
		expect(Object.keys(OWED_SPINNER).filter((f) => !found.includes(f))).toEqual([]);
	});
});

describe("the bare project's loading.tsx (#7010)", () => {
	it("is synchronous: it returns an element, not a promise", () => {
		expect(isValidElement(ProjectLoading())).toBe(true);
	});

	it("is one SkeletonRoot drawing the board it redirects to, with no spinner", () => {
		const { container } = render(<ProjectLoading />);
		const roots = container.querySelectorAll('[data-slot="skeleton-root"]');
		expect(roots).toHaveLength(1);
		expect(container.firstElementChild).toBe(roots[0]);
		expect(roots[0]?.querySelector('[data-slot="canvas-skeleton"]')).not.toBeNull();
		expect(container.querySelector(".animate-spin")).toBeNull();
	});
});

describe("the Architecture route's loading.tsx (#7212)", () => {
	it("is synchronous: it returns an element, not a promise", () => {
		expect(isValidElement(ProjectArchitectureLoading())).toBe(true);
	});

	it("is one SkeletonRoot drawing the board, and the only element that says busy", () => {
		const { container } = render(<ProjectArchitectureLoading />);
		const roots = container.querySelectorAll('[data-slot="skeleton-root"]');
		expect(roots).toHaveLength(1);
		expect(container.firstElementChild).toBe(roots[0]);
		expect(roots[0]?.querySelector('[data-slot="canvas-skeleton"]')).not.toBeNull();
		expect(container.querySelectorAll("[aria-busy]")).toHaveLength(1);
		expect(container.querySelector(".animate-spin")).toBeNull();
	});
});

describe("the bare project and the Architecture route draw the same skeleton", () => {
	it("render identical markup, so nothing moves when the redirect lands", () => {
		const bare = render(<ProjectLoading />).container.innerHTML;
		const architecture = render(<ProjectArchitectureLoading />).container.innerHTML;
		expect(architecture).toBe(bare);
	});

	it("is marked busy once in the bare project's skeleton too", () => {
		const { container } = render(<ProjectLoading />);
		expect(container.querySelectorAll("[aria-busy]")).toHaveLength(1);
	});
});

describe("BoardPreview without the page's data (#7212)", () => {
	it("is one SkeletonRoot around the board's skeleton, busy once, in either placement", () => {
		const offenders: string[] = [];
		for (const overlay of [false, true]) {
			const { container, unmount } = render(<BoardPreview overlay={overlay} />);
			const roots = container.querySelectorAll('[data-slot="skeleton-root"]');
			if (roots.length !== 1) offenders.push(`overlay=${overlay}: ${roots.length} roots`);
			if (container.firstElementChild !== roots[0]) offenders.push(`overlay=${overlay}: root not first`);
			if (!roots[0]?.querySelector('[data-slot="canvas-skeleton"]')) {
				offenders.push(`overlay=${overlay}: no canvas skeleton`);
			}
			const busy = container.querySelectorAll("[aria-busy]").length;
			if (busy !== 1) offenders.push(`overlay=${overlay}: ${busy} busy elements`);
			unmount();
		}
		expect(offenders).toEqual([]);
	});
});

describe("CanvasSkeleton is a part, not a root (rule 1)", () => {
	it("declares no busy state, role or name of its own, in either placement", () => {
		const offenders: string[] = [];
		for (const overlay of [false, true]) {
			const { container, unmount } = render(<CanvasSkeleton overlay={overlay} />);
			const part = container.querySelector('[data-slot="canvas-skeleton"]');
			for (const attr of ["aria-busy", "role", "aria-label", "aria-hidden"]) {
				if (part?.hasAttribute(attr)) offenders.push(`overlay=${overlay}: ${attr}`);
			}
			unmount();
		}
		expect(offenders).toEqual([]);
	});
});

describe("SkeletonRoot", () => {
	it("marks the region busy, and names itself for a reader and a test", () => {
		render(<SkeletonRoot data-testid="root" />);
		const root = screen.getByTestId("root");
		expect(root.tagName).toBe("DIV");
		expect(root).toHaveAttribute("aria-busy", "true");
		expect(root).toHaveAttribute("data-slot", "skeleton-root");
	});

	it("is not hidden from assistive technology and takes no role", () => {
		render(<SkeletonRoot data-testid="root" />);
		const root = screen.getByTestId("root");
		expect(root).not.toHaveAttribute("aria-hidden");
		expect(root).not.toHaveAttribute("role");
	});

	it("leaves its children in the accessibility tree", () => {
		render(
			<SkeletonRoot>
				<button type="button">Invite</button>
			</SkeletonRoot>,
		);
		expect(screen.getByRole("button", { name: "Invite" })).toBeInTheDocument();
	});

	it("passes layout through: className and other div attributes are the caller's", () => {
		render(<SkeletonRoot data-testid="root" className="space-y-5" id="members-skeleton" />);
		const root = screen.getByTestId("root");
		expect(root).toHaveClass("space-y-5");
		expect(root).toHaveAttribute("id", "members-skeleton");
	});

	it("keeps its own slot name when a caller passes one", () => {
		render(<SkeletonRoot data-testid="root" data-slot="billing-skeleton" />);
		expect(screen.getByTestId("root")).toHaveAttribute("data-slot", "skeleton-root");
	});

	it("is what a query for a pending region finds", () => {
		const { container } = render(
			<main>
				<SkeletonRoot />
			</main>,
		);
		// The selector `e2e/audit/filters.ts` reads to decide a page has not answered yet.
		expect(container.querySelector('main [aria-busy="true"]')).not.toBeNull();
	});
});
