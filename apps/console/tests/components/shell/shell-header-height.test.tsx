// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The shell has ONE header height, and its bottom border is meant to be one continuous line
// across the sidebar head, the topbar and the Elench panel header. Before `SHELL_HEADER` the
// number was typed as `h-[53px]` in four files, as `3.5rem` (56px) in the support-ask page, and
// the Elench header set no height at all — its content came out at ≈54.5px, so its seam sat
// 1.5px below the topbar's. Alignment was a property of each file's arithmetic, not of the shell.
//
// This test pins the ADOPTION, not the number: every rendered head must carry the shared class,
// and none may carry a literal height of its own. The value lives in `app/globals.css` as
// `--shell-header-h`; changing it there must move every seam at once, which is only true while
// each of these surfaces reads the variable rather than a copy of it.

import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SHELL_HEADER, SHELL_VIEWPORT } from "@/components/shell/content-frame";

const { pathname } = vi.hoisted(() => ({
	pathname: { current: "/acme/~/settings/general" },
}));

vi.mock("next/navigation", () => ({
	usePathname: () => pathname.current,
	useParams: () => ({ org: "acme" }),
	useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
	useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/app/server/actions/resolve", () => ({
	resolveProjectId: vi.fn(),
	getEnvironmentsForSlug: vi.fn(async () => []),
	resolveOrgScope: vi.fn(),
}));
vi.mock("@/lib/auth/client", () => ({
	authClient: {
		useSession: () => ({ data: { user: { name: "User", email: "user@example.com" } } }),
		signOut: vi.fn(),
		listAccounts: vi.fn(async () => ({ data: [] })),
	},
}));
vi.mock("@repo/privacy/consent-provider", () => ({
	useConsent: () => ({ openPreferences: vi.fn() }),
}));
vi.mock("@/components/org/upgrade-sheet-provider", () => ({
	useUpgradeSheet: () => ({ openUpgrade: vi.fn() }),
}));
vi.mock("@/components/settings/enterprise-gate", () => ({ useEntitlement: () => true }));
vi.mock("@/lib/query/use-projects-query", () => ({ useProjectsQuery: () => ({ data: [] }) }));
vi.mock("@/lib/query/use-jobs-query", () => ({ useJobsQuery: () => ({ data: [] }) }));
vi.mock("@/hooks/use-support-notifications", () => ({
	useSupportNotifications: () => ({
		notifications: [],
		unreadCount: 0,
		markAsRead: vi.fn(),
		markAllRead: vi.fn(),
	}),
}));
vi.mock("@/lib/stores/use-workspace-store", () => ({
	useActiveOrgSlug: () => "acme",
	useWorkspaceStore: Object.assign(
		() => ({
			activeOrgId: "org_1",
			organizations: [{ id: "org_1", name: "Acme", slug: "acme", plan: "hobby" }],
			fetchWorkspace: vi.fn(),
			switchOrg: vi.fn(),
		}),
		{ getState: () => ({ fetchWorkspace: vi.fn() }) },
	),
}));

const { AppSidebar } = await import("@/components/shell/app-sidebar");
const { SidebarRail } = await import("@/components/shell/sidebar-rail");
const { Topbar } = await import("@/components/shell/topbar");
const { ElenchPanel } = await import("@/components/agent/elench/elench-panel");

/**
 * Every element in `root` whose class list carries the shared header-height class. `classList`
 * rather than `className` on purpose: the heads hold lucide icons, and on an SVG element
 * `className` is an `SVGAnimatedString`, not a string.
 */
function shellHeads(root: HTMLElement): Element[] {
	return Array.from(root.querySelectorAll("*")).filter((el) =>
		el.classList.contains(SHELL_HEADER),
	);
}

/**
 * Every class in `root` that types a header-sized pixel height of its own (`h-[53px]`, `h-[56px]`).
 * Small literals are left alone on purpose: the nav rows size their chevrons at `h-[15px]`, and an
 * icon is not a header. Anything at 40px or more inside the shell chrome is a head re-typing the
 * number the token exists to own.
 */
function literalHeights(root: HTMLElement): string[] {
	return Array.from(root.querySelectorAll("*"))
		.flatMap((el) => Array.from(el.classList))
		.filter((cls) => {
			const px = /^h-\[(\d+)px\]$/.exec(cls);
			return px !== null && Number(px[1]) >= 40;
		});
}

describe("shell header height — one token, every seam", () => {
	it("derives both shell classes from the --shell-header-h variable", () => {
		expect(SHELL_HEADER).toContain("--shell-header-h");
		expect(SHELL_VIEWPORT).toContain("--shell-header-h");
	});

	it("the topbar <header> carries SHELL_HEADER and no literal height", () => {
		const { container } = render(<Topbar onOpenSidebar={() => {}} />);
		const header = container.querySelector("header");
		expect(header).not.toBeNull();
		expect(header?.classList.contains(SHELL_HEADER)).toBe(true);
		expect(literalHeights(container)).toEqual([]);
	});

	it("the sidebar head and the open drill head both carry SHELL_HEADER", () => {
		// A settings route is a route-owned drill, so both heads are in the DOM at once.
		const { container } = render(<AppSidebar isHosted selfRunners />);
		expect(shellHeads(container).length).toBeGreaterThanOrEqual(2);
		expect(literalHeights(container)).toEqual([]);
	});

	it("the collapsed rail's brand head carries SHELL_HEADER", () => {
		const { container } = render(<SidebarRail selfRunners />);
		expect(shellHeads(container)).toHaveLength(1);
		expect(literalHeights(container)).toEqual([]);
	});

	it("the Elench panel <header> carries SHELL_HEADER and the dock casts no shadow", () => {
		const { container } = render(
			<ElenchPanel
				isOrg
				threads={[]}
				activeId={null}
				onSelectThread={() => {}}
				onNewChat={() => {}}
			>
				<div>body</div>
			</ElenchPanel>,
		);
		const header = container.querySelector("header");
		expect(header).not.toBeNull();
		expect(header?.classList.contains(SHELL_HEADER)).toBe(true);
		// The height comes from the token, not from vertical padding around the content.
		expect(header?.classList.contains("py-2.5")).toBe(false);
		// An in-flow dock with a real seam border casts no shadow — the canvas dock has none.
		const dialog = container.querySelector('[role="dialog"]');
		expect(dialog?.className).not.toMatch(/shadow-\[/);
		expect(literalHeights(container)).toEqual([]);
	});
});
