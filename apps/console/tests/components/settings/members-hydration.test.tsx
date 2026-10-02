// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Settings · Members HYDRATES WITHOUT A MISMATCH, whatever the hydrating browser's clock, timezone
// and session state are (#5377).
//
// The release gate's audit leg failed intermittently with React #418 on `/[org]/~/settings/members`.
// Run 37035950068 (PR #5367) recorded it twice in a row; the server HTML in that trace has no
// "You" badge on the owner's row and the hydrated DOM has one. Two values were read per RENDERER
// rather than from the dehydrated payload:
//
//   · the viewer, from `authClient.useSession()`. better-auth's React `useStore` hands the client's
//     live `get` to `useSyncExternalStore` as its SERVER snapshot, so when the shell's session
//     fetch resolves before this (streamed, later-hydrating) table hydrates, the hydration render
//     adds a badge element the server never sent — #418 with `args[]=HTML`;
//   · the clock, from `formatRelative(lastActiveAt)` with no baseline, i.e. each renderer's
//     `new Date()`. Two renders straddling a `formatDistance` boundary print different strings —
//     #418 with `args[]=text`.
//
// This renders the REAL table on the "server" under one clock, timezone and session state, then
// hydrates the server's HTML under a DIFFERENT one of each, exactly the way the route seeds the
// cache (prefetch → dehydrate → HydrationBoundary). It asserts both that the two renders produce
// identical markup and that React reported no recoverable (hydration) error.
//
// Mutation check (done when this was written): restoring `authClient.useSession()` as the source
// of `isYou`, or dropping the `asOf` baseline from `formatRelative`, fails both tests.

import {
	dehydrate,
	HydrationBoundary,
	QueryClient,
	QueryClientProvider,
} from "@tanstack/react-query";
import { act, type ReactNode } from "react";
import { hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MemberRow } from "@/app/server/actions/members";
import type { MembersPage } from "@/lib/queries/members";

vi.mock("next/navigation", () => ({
	useParams: () => ({ org: "acme" }),
	useRouter: () => ({ replace: vi.fn() }),
	usePathname: () => "/acme/~/settings/members",
	useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/app/server/actions/members", () => ({
	getMembersPage: vi.fn(() => new Promise<MembersPage>(() => {})),
	setMemberSuspended: vi.fn(),
}));
vi.mock("@/app/server/actions/billing", () => ({
	getCollaborationAccess: () => new Promise(() => {}),
}));

/**
 * What the session hook returns right now. `null` on the server (no session fetch runs there); the
 * viewer's session on the client, standing for a fetch that resolved BEFORE the table hydrated.
 */
let liveSession: { user: { id: string } } | null = null;
vi.mock("@/lib/auth/client", () => ({
	authClient: { useSession: () => ({ data: liveSession }), organization: {} },
}));
vi.mock("@/lib/query/use-classification-query", () => ({
	useAssignmentsForKind: () => ({ data: {} }),
}));
vi.mock("@/components/settings/enterprise-gate", () => ({ useEntitlement: () => false }));
vi.mock("@/components/settings/members/invite-member-dialog", () => ({ InviteMemberDialog: () => null }));
vi.mock("@/components/settings/upgrade/upgrade-dialog", () => ({ UpgradeDialog: () => null }));
vi.mock("@/components/alerts/confirm-dialog", () => ({ ConfirmDialog: () => null }));
vi.mock("@/components/classification/classification-control", () => ({ ClassificationControl: () => null }));

import { MembersTable } from "@/components/settings/members/members-table";
import { useMembersFilters } from "@/lib/stores/use-settings-filters";

/** The instant the server read the page — and rendered it. */
const READ_AT = Date.parse("2026-10-02T17:03:18.000Z");
/** The viewer's last activity: 9m10s before the read, so "9 minutes ago" as of the read. */
const LAST_ACTIVE = new Date(READ_AT - (9 * 60 + 10) * 1000).toISOString();

/** One active member row. */
function member(id: string, role: string): MemberRow {
	return {
		id: `m-${id}`,
		userId: `u-${id}`,
		name: `Member ${id}`,
		username: null,
		email: `${id}@acme.test`,
		image: null,
		role,
		joinedAt: "2026-10-02T16:50:00.000Z",
		teams: [],
		status: "active",
		lastActiveAt: LAST_ACTIVE,
	};
}

/** The page `getMembersPage({})` answered with at `READ_AT`, for the viewer `u-owner`. */
const PAGE: MembersPage = {
	members: [member("owner", "owner"), member("ada", "viewer")],
	invitations: [],
	resultCount: 2,
	total: 2,
	viewerUserId: "u-owner",
	asOf: new Date(READ_AT).toISOString(),
	facets: {
		statuses: [
			{ value: "active", label: "Active", count: 2 },
			{ value: "pending", label: "Pending", count: 0 },
			{ value: "suspended", label: "Suspended", count: 0 },
		],
		roles: [
			{ value: "owner", label: "Owner", count: 1 },
			{ value: "viewer", label: "Viewer", count: 1 },
		],
		teams: [],
	},
};

/** The route's seed, as `page.tsx` builds it: the pristine key prefetched, then dehydrated. */
function dehydratedSeed() {
	const server = new QueryClient();
	server.setQueryData(["members", "acme", {}], PAGE);
	return dehydrate(server);
}

/** The table under a FRESH client cache, hydrated from the route's dehydrated state. */
function tree(state: ReturnType<typeof dehydratedSeed>): ReactNode {
	const qc = new QueryClient({ defaultOptions: { queries: { staleTime: 60_000, retry: false } } });
	return (
		<QueryClientProvider client={qc}>
			<HydrationBoundary state={state}>
				<MembersTable />
			</HydrationBoundary>
		</QueryClientProvider>
	);
}

/** One renderer's environment: its wall clock, its timezone, and what its session hook holds. */
interface Renderer {
	now: number;
	tz: string;
	session: { user: { id: string } } | null;
}

/** Puts the process into `r`'s clock, timezone and session state. */
function become(r: Renderer): void {
	vi.setSystemTime(r.now);
	process.env.TZ = r.tz;
	liveSession = r.session;
}

const SERVER: Renderer = { now: READ_AT, tz: "UTC", session: null };

/**
 * Browsers that must all hydrate the server's HTML cleanly. Each one is 50s later than the read —
 * across the 9m30s `formatDistance` boundary, so its own clock would print "10 minutes ago" — in a
 * timezone a long way from UTC, and with the session already resolved.
 */
const BROWSERS: Array<[string, Renderer]> = [
	["Auckland, session resolved, clock 50s on", { now: READ_AT + 50_000, tz: "Pacific/Auckland", session: { user: { id: "u-owner" } } }],
	["Los Angeles, session resolved, clock 50s on", { now: READ_AT + 50_000, tz: "America/Los_Angeles", session: { user: { id: "u-owner" } } }],
];

const ORIGINAL_TZ = process.env.TZ;
let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
	sessionStorage.clear();
	useMembersFilters.getState().reset();
});

afterEach(() => {
	act(() => root?.unmount());
	root = null;
	container?.remove();
	container = null;
	vi.useRealTimers();
	process.env.TZ = ORIGINAL_TZ;
	liveSession = null;
});

describe("Settings · Members renders the same markup on the server and the hydrating client (#5377)", () => {
	it.each(BROWSERS)("the server's HTML equals the client's first render — %s", (_name, browser) => {
		const state = dehydratedSeed();
		become(SERVER);
		const serverHtml = renderToString(tree(state));
		// The fixture is doing its job only if the server render carries the age under test.
		expect(serverHtml).toContain("9 minutes ago");

		become(browser);
		expect(renderToString(tree(state))).toBe(serverHtml);
	});

	it.each(BROWSERS)("hydrating the server's HTML reports no mismatch — %s", (_name, browser) => {
		const state = dehydratedSeed();
		become(SERVER);
		const serverHtml = renderToString(tree(state));

		become(browser);
		container = document.createElement("div");
		container.innerHTML = serverHtml;
		document.body.appendChild(container);
		const recoverable: unknown[] = [];
		act(() => {
			root = hydrateRoot(container as HTMLDivElement, tree(state), {
				onRecoverableError: (error) => recoverable.push(error),
			});
		});

		expect(recoverable.map((e) => (e instanceof Error ? e.message : String(e)))).toEqual([]);
		// And what is on screen is the payload's answer, not this browser's clock.
		expect(container.textContent).toContain("9 minutes ago");
		expect(container.textContent).toContain("You");
	});
});
