// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6129: the Activity feed is live — an entry recorded AFTER the page loaded appears when the
// `activity` topic's hint invalidates the feed (lib/query/topics.ts), with no reload.
//
// The defect this pins: the default window ("Last 7 days") used to travel as `from` AND a `to`
// frozen at the instant the page resolved it. The server answers `ts <= to`, so every hint
// refetched the same rows and a new entry never appeared. The fake read below answers exactly as
// the server does — it drops a row stamped after `to` — so a frozen `to` fails the second assertion.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/** The rows "in the database"; a test appends one after the feed has loaded. */
const db = vi.hoisted(() => ({
	rows: [] as Array<{ id: string; actorName: string; ts: string }>,
	inputs: [] as unknown[],
}));

/** The server's window predicate: `ts >= from` and, when a `to` is sent, `ts <= to`. */
function inWindow(input: unknown, ts: string): boolean {
	if (typeof input !== "object" || input === null) return true;
	const from = "from" in input && typeof input.from === "string" ? input.from : null;
	const to = "to" in input && typeof input.to === "string" ? input.to : null;
	return (from === null || ts >= from) && (to === null || ts <= to);
}

vi.mock("@/lib/rpc/client", async () => {
	const { fakeOrpc } = await import("@/tests/helpers/fake-orpc");
	return {
		orpc: fakeOrpc({
			"members.list": async () => [],
			"activity.page": async (input) => {
				db.inputs.push(input);
				const rows = db.rows
					.filter((r) => inWindow(input, r.ts))
					.map((r) => ({
						id: r.id,
						actorId: "00000000-0000-4000-8000-0000000000aa",
						actorName: r.actorName,
						actorEmail: null,
						actorImage: null,
						actorUsername: null,
						action: "edit",
						resourceType: "project",
						resourceId: null,
						decision: true,
						reason: null,
						ts: r.ts,
					}));
				return { rows, nextCursor: null, facets: null };
			},
		}).orpc,
	};
});
vi.mock("@/app/server/actions/activity", () => ({ getActivityExportCsv: vi.fn() }));
vi.mock("@/lib/stores/use-workspace-store", () => ({
	useActiveOrgSlug: () => "acme",
	useWorkspaceStore: (sel: (s: unknown) => unknown) => sel({ entitlements: { quotas: { activityRetentionDays: 7 } } }),
}));
vi.mock("next/navigation", () => ({
	useParams: () => ({ org: "acme" }),
	useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
	usePathname: () => "/acme/~/settings/activity",
	useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/query/use-projects-query", () => ({ useProjectsQuery: () => ({ data: [] }) }));
vi.mock("@/components/settings/enterprise-gate", () => ({ useEntitlement: () => false }));
vi.mock("@/components/org/upgrade-org-sheet", () => ({ UpgradeOrgSheet: () => null }));

import { ActivityLog } from "@/components/settings/activity/activity-log";
import { TOPIC_KEYS } from "@/lib/query/topics";
import { useActivityFilters } from "@/lib/stores/use-settings-filters";

beforeEach(() => {
	sessionStorage.clear();
	useActivityFilters.getState().reset();
	db.inputs = [];
	db.rows = [{ id: "1", actorName: "Ada Lovelace", ts: new Date(Date.now() - 60_000).toISOString() }];
});

describe("Activity feed — live by default (#6129)", () => {
	it("shows an entry recorded after the page loaded, once the activity hint invalidates the feed", async () => {
		const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		// The route's server-resolved default window: from a week ago, to the instant it ran.
		const now = Date.now();
		const defaultWindow = {
			from: new Date(now - 7 * 86_400_000).toISOString(),
			to: new Date(now).toISOString(),
		};
		render(
			<QueryClientProvider client={client}>
				<ActivityLog defaultWindow={defaultWindow} />
			</QueryClientProvider>,
		);
		expect(await screen.findByText("Ada Lovelace")).toBeInTheDocument();
		// The default window is open-ended: the read carries its `from` and no `to`.
		expect(db.inputs[0]).toMatchObject({ from: defaultWindow.from });
		expect(db.inputs[0]).not.toHaveProperty("to");

		// Recorded after load — stamped after the window's resolved `to`.
		db.rows = [{ id: "2", actorName: "Grace Hopper", ts: new Date(now + 5_000).toISOString() }, ...db.rows];
		await act(async () => {
			for (const queryKey of TOPIC_KEYS.activity()) await client.invalidateQueries({ queryKey });
		});

		expect(await screen.findByText("Grace Hopper")).toBeInTheDocument();
		expect(screen.getByText("Ada Lovelace")).toBeInTheDocument();
	});
});
