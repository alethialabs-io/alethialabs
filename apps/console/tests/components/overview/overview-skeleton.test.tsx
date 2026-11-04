// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The org overview's route skeleton (`app/(private)/[org]/loading.tsx` → `OverviewSkeleton`, #6347).
//
// The release gate's B2 on `/[org]` failed with "the skeleton sets 3 blocks side by side and the
// page sets 2": four project placeholders in a two-wide grid beside the cards column, over an org
// with ONE project. The page's shape depends on data the shell already holds — the `[org]` layout
// prefetches the project list, the job feed and the workspace context and hydrates them above the
// loading boundary — so the skeleton reads its shape from that cache, and never fetches.
//
// Mutation check (run in CI on this PR's branch): drawing a fixed four project placeholders fails
// "one placeholder per project".

import { screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeJob } from "../../fixtures/jobs";

vi.mock("@/lib/rpc/client", async () => ({ orpc: (await import("./rpc-fake")).fakeOrpc }));
// The upgrade sheet pulls in Stripe and a tree of actions; no skeleton renders it.
vi.mock("@/components/org/upgrade-sheet-provider", () => ({
	useUpgradeSheet: () => ({ openUpgrade: vi.fn() }),
}));

import { OverviewSkeleton } from "@/components/overview/overview-skeleton";
import { fakeOrpc, never, reads, renderWithReads, testClient } from "./rpc-fake";

/** What the shell's cache holds when the skeleton renders; `undefined` leaves a read out. */
interface Shell {
	projects?: unknown[];
	jobs?: unknown[];
	alerting?: boolean;
}

/** Render the skeleton over a cache seeded as the `[org]` layout's hydration would leave it. */
function renderSkeleton(shell: Shell) {
	const client = testClient();
	if (shell.projects) client.setQueryData(fakeOrpc.workspace.projects.queryKey(), shell.projects);
	if (shell.jobs) client.setQueryData(fakeOrpc.workspace.recentJobs.queryKey(), shell.jobs);
	if (shell.alerting !== undefined) {
		client.setQueryData(fakeOrpc.workspace.context.queryKey(), { entitlements: { alerting: shell.alerting } });
	}
	return renderWithReads(<OverviewSkeleton />, client);
}

/** `n` stand-in projects; the skeleton reads only how many there are. */
function projects(n: number): unknown[] {
	return Array.from({ length: n }, (_, i) => ({ id: `p${i}` }));
}

/** Within the card labelled `name`, the skeleton bars matching `selector`. */
function inCard(container: HTMLElement, name: string, selector: string): number {
	return container.querySelector(`section[aria-label="${name}"]`)?.querySelectorAll(selector).length ?? -1;
}

beforeEach(() => {
	for (const read of [reads.projects, reads.recentJobs, reads.context, reads.usage, reads.alerts]) {
		read.mockReset();
		read.mockImplementation(never);
	}
});

describe("OverviewSkeleton — the projects area", () => {
	it("one placeholder per project: one project sets one card beside the cards column", () => {
		renderSkeleton({ projects: projects(1) });
		expect(screen.getAllByTestId("project-card-skeleton")).toHaveLength(1);
	});

	it("caps the placeholders at two rows", () => {
		renderSkeleton({ projects: projects(9) });
		expect(screen.getAllByTestId("project-card-skeleton")).toHaveLength(6);
	});

	it("draws the empty panel's height as bars — no frame, no empty copy — for an org with no projects (B3)", () => {
		const { container } = renderSkeleton({ projects: [] });
		expect(screen.queryAllByTestId("project-card-skeleton")).toHaveLength(0);
		expect(screen.getByTestId("projects-empty-skeleton")).toBeInTheDocument();
		expect(container.querySelector('[data-slot="empty"]')).toBeNull();
		expect(screen.queryByText(/No projects/i)).not.toBeInTheDocument();
	});

	it("falls back to one row of two when the shell's list is not cached", () => {
		renderSkeleton({});
		expect(screen.getAllByTestId("project-card-skeleton")).toHaveLength(2);
	});
});

describe("OverviewSkeleton — the cards column", () => {
	it("draws one Recent-jobs row per job in the shell's feed", () => {
		const { container } = renderSkeleton({ jobs: [makeJob({ id: "a" }), makeJob({ id: "b" })] });
		expect(inCard(container, "Recent jobs", '[data-slot="skeleton"].size-7')).toBe(2);
	});

	it("draws the plan gate's shape, not delivery rows, when the plan has no alerting (F021)", () => {
		const { container } = renderSkeleton({ alerting: false });
		expect(inCard(container, "Alerts", '[data-slot="skeleton"].size-10')).toBe(1);
		expect(inCard(container, "Alerts", '[data-slot="skeleton"].size-2')).toBe(0);
	});

	it("draws delivery rows when the plan has alerting, or when the entitlements are not cached", () => {
		for (const alerting of [true, undefined]) {
			const { container, unmount } = renderSkeleton({ alerting });
			expect(inCard(container, "Alerts", '[data-slot="skeleton"].size-2')).toBe(2);
			expect(inCard(container, "Alerts", '[data-slot="skeleton"].size-10')).toBe(0);
			unmount();
		}
	});
});

describe("OverviewSkeleton reads", () => {
	it("never fetches — a skeleton is no reason to issue a read", () => {
		renderSkeleton({});
		for (const read of [reads.projects, reads.recentJobs, reads.context, reads.usage, reads.alerts]) {
			expect(read).not.toHaveBeenCalled();
		}
	});
});
