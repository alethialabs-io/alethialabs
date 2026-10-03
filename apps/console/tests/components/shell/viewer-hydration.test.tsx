// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Surfaces that render the signed-in person HYDRATE WITHOUT A MISMATCH, whenever the browser's own
// session fetch resolves (#5382).
//
// better-auth's React `useStore` hands the client's live `get` to `useSyncExternalStore` as its
// SERVER snapshot, so a component rendering from `authClient.useSession()` hydrates against the
// browser's session as it is at that instant — not against the HTML the server sent. #5380 found
// it as an intermittent React #418 on the members page; the shell, the account dialog, the org /
// upgrade / AI sheets and invite-accept all read the same hook. They now read `useViewer()`, which
// renders the server's seed until the component has hydrated.
//
// The harness is #5380's (tests/components/settings/members-hydration.test.tsx): the "server"
// renders at a fixed clock with NO live session (no session fetch runs there), then the "browser"
// hydrates that HTML with the session ALREADY RESOLVED — the losing side of the race. It asserts
// identical markup and no recoverable (hydration) error. Two surfaces, one per path of the hook:
//   · SidebarProfile — under `ViewerProvider`, the SEEDED path every private route takes;
//   · invite-accept  — a public route with no provider, the UNSEEDED path.
//
// Mutation check (done when this was written, once per surface): reading `authClient.useSession()`
// directly again fails BOTH of that surface's tests — SidebarProfile with "Hydration failed because
// the server rendered text didn't match the client" (the name differs), invite-accept with "…
// rendered HTML didn't match…" (a card where the server sent a spinner).

import { act, type ReactNode } from "react";
import { hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Viewer } from "@/lib/auth/viewer";

vi.mock("next/navigation", () => ({
	usePathname: () => "/acme/~/settings/general",
	useParams: () => ({ org: "acme" }),
	useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
	useSearchParams: () => new URLSearchParams("token=inv_1"),
}));
vi.mock("next-runtime-env", () => ({ env: () => undefined }));

/** A resolved better-auth session, as the client's hook holds it. */
interface LiveSession {
	data: { user: Viewer } | null;
	isPending: boolean;
	error: null;
}

/**
 * What better-auth's session hook returns right now. Pending with no data on the server (no
 * session fetch runs there); resolved on the browser, standing for a fetch that won the race
 * against hydration.
 */
let live: LiveSession = { data: null, isPending: true, error: null };
vi.mock("@/lib/auth/client", () => ({
	authClient: {
		useSession: () => live,
		signOut: vi.fn(),
		listAccounts: vi.fn(async () => ({ data: [] })),
		organization: { acceptInvitation: vi.fn(), rejectInvitation: vi.fn() },
	},
}));
vi.mock("@repo/privacy/consent-provider", () => ({
	useConsent: () => ({ openPreferences: vi.fn() }),
	useOptionalConsent: () => null,
}));
vi.mock("@/components/org/upgrade-sheet-provider", () => ({
	useUpgradeSheet: () => ({ openUpgrade: vi.fn() }),
}));
// Closed on first render; their own modules reach server actions this test has no use for.
vi.mock("@/components/shell/account-settings-dialog", () => ({ AccountSettingsDialog: () => null }));
vi.mock("@/components/shell/feedback-dialog", () => ({ FeedbackDialog: () => null }));
vi.mock("@/components/shell/notifications-popover", () => ({ NotificationsPopover: () => null }));
vi.mock("@/components/settings/enterprise-gate", () => ({ useEntitlement: () => true }));
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
		() => ({ activeOrgId: "org_1", organizations: [], fetchWorkspace: vi.fn(), switchOrg: vi.fn() }),
		{ getState: () => ({ fetchWorkspace: vi.fn() }) },
	),
}));

import { ViewerProvider } from "@/components/providers/viewer-provider";
import { SidebarProfile } from "@/components/shell/sidebar-profile";
import AcceptInvitePage from "@/app/(public)/invites/accept/page";

/** The instant the server read the session and rendered the page. */
const READ_AT = Date.parse("2026-10-02T17:03:18.000Z");

/** The person the server's session named for this request. */
const ADA: Viewer = {
	id: "u-ada",
	name: "Ada Lovelace",
	email: "ada@acme.test",
	image: null,
	createdAt: new Date("2026-01-15T09:00:00.000Z"),
};

/** The same person, renamed in another tab after the server read — what the browser's fetch holds. */
const ADA_RENAMED: Viewer = { ...ADA, name: "Ada King" };

/** One renderer's environment: its wall clock and what better-auth's session hook holds. */
interface Renderer {
	now: number;
	session: LiveSession;
}

const SERVER: Renderer = { now: READ_AT, session: { data: null, isPending: true, error: null } };
/** 50s later, with the session fetch already resolved before hydration. */
const BROWSER: Renderer = {
	now: READ_AT + 50_000,
	session: { data: { user: ADA_RENAMED }, isPending: false, error: null },
};

/** Puts the process into `r`'s clock and session state. */
function become(r: Renderer): void {
	vi.setSystemTime(r.now);
	live = r.session;
}

/** A surface under test: its tree, a string the SERVER's render must contain, and the live one. */
interface Surface {
	tree: () => ReactNode;
	serverShows: string;
	afterHydrationShows: string;
}

const SURFACES: Array<[string, Surface]> = [
	[
		"SidebarProfile, seeded by the private layout",
		{
			// The layout's seed is the server's read of the session — on both sides of hydration.
			tree: () => (
				<ViewerProvider viewer={ADA}>
					<SidebarProfile />
				</ViewerProvider>
			),
			serverShows: "Ada Lovelace",
			afterHydrationShows: "Ada King",
		},
	],
	[
		"invite-accept, a public route with no seed",
		{
			tree: () => <AcceptInvitePage />,
			// No seed: both sides render the pending state first, then the card once hydrated.
			serverShows: "animate-spin",
			afterHydrationShows: "ada@acme.test",
		},
	],
];

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
});

afterEach(() => {
	act(() => root?.unmount());
	root = null;
	container?.remove();
	container = null;
	vi.useRealTimers();
	live = { data: null, isPending: true, error: null };
});

describe("surfaces rendering the signed-in person hydrate without a mismatch (#5382)", () => {
	it.each(SURFACES)("the server's HTML equals the client's first render — %s", (_name, surface) => {
		become(SERVER);
		const serverHtml = renderToString(surface.tree());
		// The fixture is doing its job only if the server render carries the state under test.
		expect(serverHtml).toContain(surface.serverShows);

		become(BROWSER);
		expect(renderToString(surface.tree())).toBe(serverHtml);
	});

	it.each(SURFACES)("hydrating the server's HTML reports no mismatch — %s", (_name, surface) => {
		become(SERVER);
		const serverHtml = renderToString(surface.tree());

		become(BROWSER);
		container = document.createElement("div");
		container.innerHTML = serverHtml;
		document.body.appendChild(container);
		const recoverable: unknown[] = [];
		act(() => {
			root = hydrateRoot(container as HTMLDivElement, surface.tree(), {
				onRecoverableError: (error) => recoverable.push(error),
			});
		});

		expect(recoverable.map((e) => (e instanceof Error ? e.message : String(e)))).toEqual([]);
		// Once hydrated, the surface follows the LIVE session, not the seed it hydrated with.
		expect(container.innerHTML).toContain(surface.afterHydrationShows);
	});
});
