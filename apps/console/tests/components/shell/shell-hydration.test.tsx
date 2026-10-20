// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The shell hydrates the layout's seed without a mismatch (#6114).
//
// Since the `[org]` layout prefetches the shell's reads, the server renders the chrome WITH data —
// the org, the projects, the job and support-case feeds, the setup guide. Anything in the chrome
// that renders from that data AND from something only the browser holds (localStorage read marks,
// the clock, the browser timezone) now disagrees with the server's HTML, and React throws #418 and
// discards it — on every org page at once. The release gate caught exactly that on the first push
// of #6193: the setup ring's `<title>` held three text nodes, whose `<!-- -->` separators a
// `<title>` cannot carry. This test server-renders the real sidebar and topbar against a seeded
// cache, hydrates that HTML in a "browser" that also holds read marks the server cannot see, and
// requires no recoverable error. (The read marks are safe by construction: zustand hydrates with
// the store's INITIAL state as the server snapshot. They are here so a change to that is caught.)

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactNode } from "react";
import { hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const { LIVE } = vi.hoisted(() => ({
	LIVE: { data: null, isPending: true, error: null },
}));

vi.mock("next/navigation", () => ({
	usePathname: () => "/acme/~/jobs",
	useParams: () => ({ org: "acme" }),
	useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
	useSearchParams: () => new URLSearchParams(),
}));
vi.mock("next-runtime-env", () => ({ env: () => undefined }));
vi.mock("@/lib/auth/client", () => ({
	authClient: { signOut: vi.fn(), listAccounts: vi.fn(async () => ({ data: [] })) },
	liveSession: { subscribe: () => () => {}, get: () => LIVE, onChange: () => () => {} },
}));
vi.mock("@repo/privacy/consent-provider", () => ({
	useConsent: () => ({ openPreferences: vi.fn() }),
	useOptionalConsent: () => null,
}));
vi.mock("@/components/org/upgrade-sheet-provider", () => ({
	useUpgradeSheet: () => ({ openUpgrade: vi.fn() }),
}));
vi.mock("@/components/org/create-org-sheet", () => ({ CreateOrgSheet: () => null }));
// Server modules the chrome's action imports reach; nothing here calls them.
vi.mock("@/lib/auth", () => ({ auth: {} }));
vi.mock("@/app/server/actions/resolve", () => ({ resolveProjectId: vi.fn(), resolveOrgScope: vi.fn() }));

import { ViewerProvider } from "@/components/providers/viewer-provider";
import { AppSidebar } from "@/components/shell/app-sidebar";
import { Topbar } from "@/components/shell/topbar";
import { COMMUNITY_ENTITLEMENTS } from "@/lib/billing/plan";
import { qk } from "@/lib/query/keys";
import { orpc } from "@/lib/rpc/client";
import { useNotificationsStore } from "@/lib/stores/use-notifications-store";

const NOW = new Date("2026-10-20T12:00:00.000Z");

/** A client holding everything the `[org]` layout hydrates for `/acme/~/jobs`. */
function seeded(): QueryClient {
	const c = new QueryClient({
		defaultOptions: { queries: { staleTime: Number.POSITIVE_INFINITY, retry: false } },
	});
	c.setQueryData(orpc.workspace.context.queryKey(), {
		activeOrgId: "org-acme",
		organizations: [
			{ id: "org-acme", name: "Acme", slug: "acme", logo: null, role: "owner", plan: "team", status: "active" },
		],
		entitlements: COMMUNITY_ENTITLEMENTS,
		isHosted: true,
	});
	c.setQueryData(orpc.workspace.projects.queryKey(), []);
	c.setQueryData(qk.jobs("acme"), [
		{
			id: "job-1",
			job_type: "DEPLOY",
			status: "SUCCESS",
			created_at: NOW,
			completed_at: NOW,
			project_name: "shop",
			environment_name: "prod",
		},
	]);
	c.setQueryData(orpc.workspace.supportCases.queryKey(), [
		{
			id: "case-1",
			case_number: 1,
			subject: "help",
			type: "technical",
			category: "other",
			severity: "normal",
			status: "open",
			last_author_type: "staff",
			last_message_at: NOW,
			created_at: NOW,
			unread: true,
			requester_name: null,
			is_mine: true,
		},
	]);
	c.setQueryData(orpc.workspace.setupGuide.queryKey(), {
		hasCloud: false,
		hasProject: false,
		hasProvisioned: false,
		canInvite: false,
		memberCount: 1,
	});
	return c;
}

/** The chrome as the shell mounts it, under a seeded cache. */
function Chrome(): ReactNode {
	return (
		<QueryClientProvider client={seeded()}>
			<ViewerProvider
				viewer={{ id: "u1", name: "Ada", email: "ada@acme.test", image: null, createdAt: NOW }}
			>
				<AppSidebar isHosted selfRunners={false} />
				<Topbar onOpenSidebar={() => {}} />
			</ViewerProvider>
		</QueryClientProvider>
	);
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
	act(() => root?.unmount());
	root = null;
	container?.remove();
	container = null;
});

describe("the seeded shell hydrates (#6114)", () => {
	it("reports no mismatch when this browser holds read marks the server cannot see", async () => {
		// The server has no localStorage, so no read marks…
		useNotificationsStore.setState({ readJobIds: [], readSupportCaseIds: [] });
		const serverHtml = renderToString(<Chrome />);
		// The fixture does its job only if the server render carries the seeded chrome: the org and
		// the setup ring (which a client fetch used to fill after hydration).
		expect(serverHtml).toContain("Acme");
		expect(serverHtml).toContain("steps done");
		// …and the browser marked both notifications read in an earlier session (the persisted store
		// loads them from localStorage before anything renders).
		useNotificationsStore.setState({ readJobIds: ["job-1"], readSupportCaseIds: ["case-1"] });
		container = document.createElement("div");
		container.innerHTML = serverHtml;
		document.body.appendChild(container);
		const recoverable: unknown[] = [];
		const target = container;
		await act(async () => {
			root = hydrateRoot(target, <Chrome />, {
				onRecoverableError: (error) => recoverable.push(error),
			});
		});
		expect(recoverable.map((e) => (e instanceof Error ? e.message : String(e)))).toEqual([]);
	});
});
