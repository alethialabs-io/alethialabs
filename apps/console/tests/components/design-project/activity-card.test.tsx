// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The activity card replaces a floating eight-row list with no paging. What matters: the rows
// render in the board's job vocabulary, the shared `ListFooter`'s "Load more" walks the keyset
// cursor and grows the list (LST-10 #7492), pending / empty / failed are three different renders
// (RUBRIC B4), a failed LATER page keeps the rows, a live refetch never draws a job twice, no raw
// server message reaches the screen, and no dialog/overlay is involved. The read is
// `canvas.environmentJobs` (#6119), with no poll.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { EnvironmentJobsPage } from "@/app/server/actions/canvas-jobs";
import { EnvironmentStatusProvider } from "@/lib/canvas/environment-status-context";
import { EMPTY_ENVIRONMENT_STATUS } from "@/lib/canvas/component-status";
import type { FakeCall, FakeHandler } from "@/tests/helpers/fake-orpc";

const h = vi.hoisted(() => {
	const handlers: Record<string, FakeHandler> = {};
	const calls: FakeCall[] = [];
	return { handlers, calls };
});
vi.mock("@/lib/rpc/client", async () => {
	const { fakeOrpc } = await import("@/tests/helpers/fake-orpc");
	return { orpc: fakeOrpc(h.handlers, h.calls).orpc };
});
vi.mock("next/navigation", () => ({ useParams: () => ({ org: "acme" }) }));

const { ActivityCard } = await import("@/components/design-project/canvas/cards/activity-card");

/** Long enough for useKeysetList's one retry of a real failure (TanStack's first back-off is 1s). */
const RETRIED = { timeout: 4000 };

function page(ids: string[], nextCursor: string | null, first = true): EnvironmentJobsPage {
	return {
		rows: ids.map((id, i) => ({
			id,
			type: "DEPLOY",
			status: "SUCCESS",
			createdAt: new Date(Date.UTC(2026, 8, 7, 12, 0, i)).toISOString(),
			error: null,
		})),
		nextCursor,
		facets: null,
		universeEmpty: first ? ids.length === 0 : null,
	};
}

let qc: QueryClient;

function wrap(children: ReactNode) {
	return (
		<QueryClientProvider client={qc}>
			<EnvironmentStatusProvider value={EMPTY_ENVIRONMENT_STATUS}>{children}</EnvironmentStatusProvider>
		</QueryClientProvider>
	);
}

/** Answers each `canvas.environmentJobs` read with the next of `pages`. */
function serve(...pages: Array<EnvironmentJobsPage | Error>) {
	const queue = [...pages];
	h.handlers["canvas.environmentJobs"] = async () => {
		const next = queue.shift();
		if (!next) throw new Error("no more pages");
		if (next instanceof Error) throw next;
		return next;
	};
}

beforeEach(() => {
	qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	h.calls.length = 0;
});

describe("ActivityCard", () => {
	it("lists the jobs and walks the cursor on Load more", async () => {
		serve(page(["job-1", "job-2"], "c1"), page(["job-3"], null, false));
		render(wrap(<ActivityCard projectId="p1" environmentId="e1" />));

		expect(await screen.findAllByRole("link")).toHaveLength(2);
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

		await userEvent.setup().click(screen.getByRole("button", { name: /load more/i }));
		expect(await screen.findAllByRole("link")).toHaveLength(3);
		// Page one carries no cursor at all; page two carries the server's, verbatim.
		expect(h.calls[0]?.input).toEqual({ projectId: "p1", environmentId: "e1", limit: 20 });
		expect(h.calls[1]?.input).toEqual({ projectId: "p1", environmentId: "e1", limit: 20, cursor: "c1" });
		// The last page came back without a cursor, so the footer renders nothing — not a count.
		expect(screen.queryByRole("button", { name: /load more/i })).not.toBeInTheDocument();
	});

	it("keeps the loaded jobs when a later page fails, and retries it from the footer", async () => {
		serve(page(["job-1"], "c1"), new Error("x"), new Error("x"), page(["job-2"], null, false));
		render(wrap(<ActivityCard projectId="p1" environmentId="e1" />));
		await screen.findAllByRole("link");

		const user = userEvent.setup();
		await user.click(screen.getByRole("button", { name: /load more/i }));
		expect(await screen.findByText(/couldn't load more/i, undefined, RETRIED)).toBeInTheDocument();
		expect(screen.getAllByRole("link")).toHaveLength(1);
		expect(screen.queryByText(/couldn't load the activity/i)).not.toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: /try again/i }));
		expect(await screen.findAllByRole("link")).toHaveLength(2);
	});

	it("a live refetch that lifts a new job onto page one draws every job once", async () => {
		let live = false;
		h.handlers["canvas.environmentJobs"] = async (input) => {
			const cursor = typeof input === "object" && input !== null && "cursor" in input ? input.cursor : undefined;
			if (cursor === undefined) return live ? page(["job-0", "job-1"], "c1") : page(["job-1"], "c1");
			// Page two still holds job-1 after the lift: the join must keep its first occurrence only.
			return page(["job-1", "job-2"], null, false);
		};
		render(wrap(<ActivityCard projectId="p1" environmentId="e1" />));
		await screen.findAllByRole("link");
		await userEvent.setup().click(screen.getByRole("button", { name: /load more/i }));
		await waitFor(() => expect(screen.getAllByRole("link")).toHaveLength(2));

		live = true;
		await act(async () => {
			await qc.invalidateQueries();
		});
		await waitFor(() => expect(screen.getAllByRole("link")).toHaveLength(3));
		const hrefs = screen.getAllByRole("link").map((a) => a.getAttribute("href"));
		expect(new Set(hrefs).size).toBe(hrefs.length);
	});

	it("says nothing has run when the environment has no jobs", async () => {
		serve(page([], null));
		render(wrap(<ActivityCard projectId="p1" environmentId="e1" />));
		expect(await screen.findByText(/nothing has run here yet/i)).toBeInTheDocument();
	});

	it("shows a placeholder list while the first page loads — not the empty state", () => {
		h.handlers["canvas.environmentJobs"] = () => new Promise(() => {});
		render(wrap(<ActivityCard projectId="p1" environmentId="e1" />));
		expect(screen.getByLabelText(/loading the activity/i)).toBeInTheDocument();
		expect(screen.queryByText(/nothing has run here yet/i)).not.toBeInTheDocument();
	});

	it("shows a region error with a retry when the read fails — never the raw message, never empty", async () => {
		// Two failures: useKeysetList retries a real failure once before it is the region's.
		serve(new Error("internal detail"), new Error("internal detail"), page(["job-1"], null));
		render(wrap(<ActivityCard projectId="p1" environmentId="e1" />));
		expect(await screen.findByRole("alert", undefined, RETRIED)).toHaveTextContent(/couldn't load the activity/i);
		expect(screen.queryByText("internal detail")).not.toBeInTheDocument();
		expect(screen.queryByText(/nothing has run here yet/i)).not.toBeInTheDocument();

		await userEvent.setup().click(screen.getByRole("button", { name: /try again/i }));
		expect(await screen.findAllByRole("link")).toHaveLength(1);
	});

	it("declares no poll", async () => {
		serve(page(["job-1"], null));
		render(wrap(<ActivityCard projectId="p1" environmentId="e1" />));
		await screen.findAllByRole("link");
		const [query] = qc.getQueryCache().getAll();
		expect(query?.observers[0]?.options.refetchInterval).toBeUndefined();
	});
});
