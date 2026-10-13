// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// A page component that reads a query the SHELL also reads must hydrate the server's HTML, even
// when the shell's fetch has filled the cache by the time the page hydrates (#5786).
//
// The release gate's audit leg went red on #5830 with React #418 on `/[org]` (and `/dashboard`,
// which lands there), `/[org]/~/support/my-cases` and `/[org]/[project]/settings/activity`
// (release-gate run 37901209188). Until #5830 a returning visitor's streamed page boundaries were
// rendered on the client, never hydrated, so no mismatch inside them could be reported. Once they
// hydrated, three read a cache the shell fills after ITS hydration:
//
//   · the overview's Recent jobs card — `useJobsQuery`, also read by the app shell;
//   · the My cases list — `qk.supportCases("all")`, also read by the notifications bell;
//   · the project Activity caption — `useProjectsQuery`, also read by the project switcher.
//
// On the server none of those had data, so each rendered its pending state. In the browser the
// page's boundary hydrates in a later pass than the shell, and when the shell's fetch landed in
// between, the hydration render drew the data instead — a skeleton became rows (`args[]=HTML`),
// "this project" became the project's name (`args[]=text`). The audit trace shows the page's
// Base UI ids going from server (`_R_…`) to client (`_r_…`): React threw the page's HTML away.
//
// Each test renders the component on the "server" with an empty cache, then hydrates that HTML
// with the cache already holding the answer, and asserts React reported nothing and the answer is
// on screen once hydration is over.
//
// Mutation check (done when this was written): making `useHydrated` answer `true` during hydration
// fails all three tests with React's hydration error in `recoverable` — "server rendered HTML" for
// the two lists and "server rendered text" for the caption, the same two #418 arguments CI logged.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactNode } from "react";
import { hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CaseListItem } from "@/lib/queries/support";
import { qk } from "@/lib/query/keys";
import { makeJob } from "../fixtures/jobs";

vi.mock("next/navigation", () => ({
	useParams: () => ({ org: "acme" }),
	useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
	usePathname: () => "/acme",
	useSearchParams: () => new URLSearchParams(),
}));

// Every fetch stays in flight: the only data either renderer sees is what the test puts in its cache.
vi.mock("@/app/server/actions/jobs", () => ({
	getJobs: () => new Promise(() => {}),
	getJob: () => new Promise(() => {}),
	cancelJob: vi.fn(),
	rerunJob: vi.fn(),
}));
vi.mock("@/app/server/actions/support", () => ({
	listMyCases: () => new Promise(() => {}),
}));
vi.mock("@/app/server/actions/members", () => ({ getMembers: () => new Promise(() => {}) }));
vi.mock("@/app/server/actions/activity", () => ({
	getActivityLog: () => new Promise(() => {}),
	getActivityExportCsv: vi.fn(),
}));

/**
 * What the projects query holds right now: nothing on the server (no fetch runs there); the org's
 * projects in the browser, standing for the project switcher's fetch landing before the feed hydrates.
 */
let liveProjects: Array<{ id: string; project_name: string; slug: string }> | undefined;
vi.mock("@/lib/query/use-projects-query", () => ({
	useProjectsQuery: () => ({ data: liveProjects }),
}));
vi.mock("@/lib/stores/use-workspace-store", () => ({
	useActiveOrgSlug: () => "acme",
	useWorkspaceStore: (sel: (s: unknown) => unknown) =>
		sel({ entitlements: { quotas: { activityRetentionDays: 7 } } }),
}));
vi.mock("@/components/settings/enterprise-gate", () => ({ useEntitlement: () => false }));
vi.mock("@/components/org/upgrade-org-sheet", () => ({ UpgradeOrgSheet: () => null }));

import { RecentJobsCard } from "@/components/overview/recent-jobs-card";
import { CaseList } from "@/components/support/cases/case-list";
import { ActivityLog } from "@/components/settings/activity/activity-log";
import { useSupportFilters } from "@/lib/stores/use-support-filters";

/** A fresh cache, as each renderer has its own; `seed` stands for a shell fetch that has landed. */
function client(seed?: (qc: QueryClient) => void): QueryClient {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 60_000 } } });
	seed?.(qc);
	return qc;
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

/**
 * Server-render `ui` against an empty cache, hydrate that HTML against `browserCache`, and return
 * what React reported. Hydration runs inside `act`, so the re-render that follows it has committed.
 */
async function serverThenHydrate(
	ui: ReactNode,
	browserCache: QueryClient,
	beforeHydrate?: () => void,
): Promise<{ serverHtml: string; recoverable: unknown[] }> {
	const serverHtml = renderToString(
		<QueryClientProvider client={client()}>{ui}</QueryClientProvider>,
	);
	beforeHydrate?.();
	container = document.createElement("div");
	container.innerHTML = serverHtml;
	document.body.appendChild(container);
	const recoverable: unknown[] = [];
	const target = container;
	await act(async () => {
		root = hydrateRoot(target, <QueryClientProvider client={browserCache}>{ui}</QueryClientProvider>, {
			onRecoverableError: (error) => recoverable.push(error),
		});
	});
	return { serverHtml, recoverable };
}

beforeEach(() => {
	sessionStorage.clear();
	useSupportFilters.getState().reset();
	liveProjects = undefined;
});

afterEach(() => {
	act(() => root?.unmount());
	root = null;
	container?.remove();
	container = null;
});

describe("a page reading a query the shell also reads hydrates cleanly (#5786)", () => {
	it("the overview's Recent jobs card", async () => {
		const browser = client((qc) =>
			qc.setQueryData(qk.jobs("acme"), [makeJob({ id: "j1", project_name: "payments", status: "SUCCESS" })]),
		);
		const { serverHtml, recoverable } = await serverThenHydrate(<RecentJobsCard orgSlug="acme" />, browser);

		// The fixture is doing its job only if the server rendered the pending state.
		expect(serverHtml).not.toContain("payments");
		expect(recoverable).toEqual([]);
		expect(container?.textContent).toContain("payments");
	});

	it("the My cases list", async () => {
		const item: CaseListItem = {
			id: "c1",
			case_number: 1042,
			subject: "Runner cannot reach the registry",
			type: "technical",
			category: "runners",
			severity: "normal",
			status: "open",
			last_message_at: new Date("2026-10-09T08:00:00.000Z"),
			last_author_type: "customer",
			created_at: new Date("2026-10-09T08:00:00.000Z"),
			unread: false,
			requester_name: null,
			is_mine: true,
		};
		const browser = client((qc) => qc.setQueryData(qk.supportCases("all"), [item]));
		const { serverHtml, recoverable } = await serverThenHydrate(
			<CaseList orgSlug="acme" seeAll={false} />,
			browser,
		);

		expect(serverHtml).not.toContain("Runner cannot reach the registry");
		expect(recoverable).toEqual([]);
		expect(container?.textContent).toContain("Runner cannot reach the registry");
	});

	it("the project Activity caption", async () => {
		const { serverHtml, recoverable } = await serverThenHydrate(
			<ActivityLog projectId="s1" />,
			client(),
			() => {
				liveProjects = [{ id: "s1", project_name: "payments-api", slug: "payments-api" }];
			},
		);

		expect(serverHtml).toContain("this project");
		expect(recoverable).toEqual([]);
		expect(container?.textContent).toContain("Activity in payments-api.");
	});
});
