// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The overview's Recent-jobs card, over the shell's job feed (`workspace.recentJobs`, #6114).
//
// #707: a failed jobs read must render the error affordance, NOT "No jobs yet" (which would tell the
// user they have no jobs when the request failed). #6118 adds the forbidden render and the
// region-error shape, and pins that a prefetched feed costs the card no read of its own.

import { QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeJob } from "../../fixtures/jobs";

vi.mock("@/lib/rpc/client", async () => ({ orpc: (await import("./rpc-fake")).fakeOrpc }));

import { RecentJobsCard, RecentJobsCardSkeleton } from "@/components/overview/recent-jobs-card";
import { fakeOrpc, forbidden, never, reads, renderWithReads, testClient } from "./rpc-fake";

/** Renders the card with `rows` already in the cache — what the page's prefetch hands it. */
function renderAnswered(rows: unknown[]) {
	const client = testClient();
	client.setQueryData(fakeOrpc.workspace.recentJobs.queryKey(), rows);
	return renderWithReads(<RecentJobsCard orgSlug="acme" />, client);
}

beforeEach(() => {
	reads.recentJobs.mockReset();
	reads.recentJobs.mockImplementation(never);
});

describe("RecentJobsCard read", () => {
	it("reads nothing on mount when the page prefetched it (B1)", () => {
		renderAnswered([makeJob({ id: "j1", project_name: "payments", status: "SUCCESS" })]);
		expect(screen.getByText("payments")).toBeInTheDocument();
		expect(reads.recentJobs).not.toHaveBeenCalled();
	});

	it("shows only the newest five", () => {
		const rows = Array.from({ length: 7 }, (_, i) => makeJob({ id: `j${i}`, project_name: `p${i}` }));
		renderAnswered(rows);
		expect(screen.getByText("p4")).toBeInTheDocument();
		expect(screen.queryByText("p5")).not.toBeInTheDocument();
	});
});

describe("RecentJobsCard states", () => {
	it("a failed read is an error with a retry (not 'No jobs yet')", async () => {
		reads.recentJobs.mockRejectedValue(new Error("boom"));
		const { container } = renderWithReads(<RecentJobsCard orgSlug="acme" />);
		expect(await screen.findByText(/Couldn't load recent jobs/i)).toBeInTheDocument();
		expect(container.querySelector("[data-slot='region-error']")).not.toBeNull();
		expect(screen.queryByText(/No jobs yet/i)).not.toBeInTheDocument();

		reads.recentJobs.mockResolvedValue([makeJob({ id: "j1", project_name: "payments" })]);
		fireEvent.click(screen.getByRole("button", { name: /try again/i }));
		await waitFor(() => expect(screen.getByText("payments")).toBeInTheDocument());
	});

	it("forbidden is its own render, not an error and not empty", async () => {
		reads.recentJobs.mockRejectedValue(forbidden());
		const { container } = renderWithReads(<RecentJobsCard orgSlug="acme" />);
		expect(await screen.findByText("You don't have access to jobs.")).toBeInTheDocument();
		expect(container.querySelector("[data-slot='region-error']")).toBeNull();
		expect(screen.queryByText(/No jobs yet/i)).not.toBeInTheDocument();
	});

	it("shows the empty state when the read answers with no jobs", () => {
		renderAnswered([]);
		expect(screen.getByText(/No jobs yet/i)).toBeInTheDocument();
		expect(screen.queryByText(/Couldn't load/i)).not.toBeInTheDocument();
	});

	it("shows neither error nor empty while the first read is pending (B3)", () => {
		const { container } = renderWithReads(<RecentJobsCard orgSlug="acme" />);
		expect(container.querySelector("[aria-busy='true']")).not.toBeNull();
		expect(screen.queryByText(/No jobs yet/i)).not.toBeInTheDocument();
		expect(screen.queryByText(/Couldn't load/i)).not.toBeInTheDocument();
	});
});

// The header said "last 24h" while nothing applies such a window — the card renders the newest
// MAX_ROWS jobs whatever their age. On the production overview that read as five drift jobs failing
// today when the newest was a week old and the oldest a month.
describe("RecentJobsCard header label", () => {
	it("does not claim a time window it does not apply", () => {
		const old = new Date("2026-07-01T00:00:00Z");
		renderAnswered([
			makeJob({ id: "j1", status: "FAILED", job_type: "DETECT_DRIFT", created_at: old, completed_at: old, project_name: "a640" }),
		]);
		expect(screen.queryByText(/last 24h/i)).not.toBeInTheDocument();
		expect(screen.getByText("a640")).toBeInTheDocument();
	});
});

// #6347: the release gate's B1 held `/[org]` with every read stalled — so the render it saw was the
// SERVER's — and the card was a skeleton there, its rows arriving only after hydration. The page now
// hands the feed down in its own boundary and says so (`prefetched`); the card then draws the rows in
// the server HTML, and the hydrating render — which holds the same feed — draws the same rows.
//
// Mutation check (run in CI on this PR's branch, #6347): dropping `|| prefetched` from the card's `drawable`
// fails the first test ("payments" missing from the server HTML).
describe("RecentJobsCard first paint (B1)", () => {
	const rows = [makeJob({ id: "j1", project_name: "payments", status: "SUCCESS", job_type: "PLAN" })];

	/** Server-render the card with the feed in the cache, then hydrate that HTML with the same feed. */
	async function serverThenHydrate(prefetched: boolean) {
		const server = testClient();
		server.setQueryData(fakeOrpc.workspace.recentJobs.queryKey(), rows);
		const ui = <RecentJobsCard orgSlug="acme" prefetched={prefetched} />;
		const serverHtml = renderToString(<QueryClientProvider client={server}>{ui}</QueryClientProvider>);
		const browser = testClient();
		browser.setQueryData(fakeOrpc.workspace.recentJobs.queryKey(), rows);
		const container = document.createElement("div");
		container.innerHTML = serverHtml;
		document.body.appendChild(container);
		const recoverable: unknown[] = [];
		let root: ReturnType<typeof hydrateRoot> | undefined;
		await act(async () => {
			root = hydrateRoot(container, <QueryClientProvider client={browser}>{ui}</QueryClientProvider>, {
				onRecoverableError: (error) => recoverable.push(error),
			});
		});
		const text = container.textContent ?? "";
		act(() => root?.unmount());
		container.remove();
		return { serverHtml, recoverable, text };
	}

	it("draws the prefetched rows in the server HTML, and hydrates them cleanly", async () => {
		const { serverHtml, recoverable, text } = await serverThenHydrate(true);
		expect(serverHtml).toContain("payments");
		// The rows, not the pending frame: no skeleton and nothing busy in the first paint.
		expect(serverHtml).not.toContain('data-slot="skeleton"');
		expect(serverHtml).not.toContain('aria-busy="true"');
		expect(recoverable).toEqual([]);
		expect(text).toContain("payments");
		expect(reads.recentJobs).not.toHaveBeenCalled();
	});

	it("without the page's word, keeps to the pending frame on the server (#5786)", async () => {
		const { serverHtml, recoverable, text } = await serverThenHydrate(false);
		expect(serverHtml).not.toContain("payments");
		expect(recoverable).toEqual([]);
		expect(text).toContain("payments");
	});
});

// #6347 (B2): the route skeleton draws as many rows as the shell's feed holds, so the card does not
// shrink from three placeholder rows to the org's two real ones when it answers.
describe("RecentJobsCardSkeleton rows", () => {
	/** How many job-row placeholders a skeleton render drew (each row has one size-7 tile). */
	function rowsDrawn(container: HTMLElement): number {
		return container.querySelectorAll('[data-slot="skeleton"].size-7').length;
	}

	it("draws three rows when the caller does not know", () => {
		const { container } = renderWithReads(<RecentJobsCardSkeleton />);
		expect(rowsDrawn(container)).toBe(3);
	});

	it("draws the rows the caller knows of, capped at the card's five", () => {
		expect(rowsDrawn(renderWithReads(<RecentJobsCardSkeleton rows={2} />).container)).toBe(2);
		expect(rowsDrawn(renderWithReads(<RecentJobsCardSkeleton rows={20} />).container)).toBe(5);
	});

	it("draws the empty line's height, and no empty copy, for an org with no jobs (B3)", () => {
		const { container } = renderWithReads(<RecentJobsCardSkeleton rows={0} />);
		expect(rowsDrawn(container)).toBe(0);
		expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBe(1);
		expect(container.querySelector('[data-slot="empty"]')).toBeNull();
		expect(screen.queryByText(/No jobs yet/i)).not.toBeInTheDocument();
	});
});
