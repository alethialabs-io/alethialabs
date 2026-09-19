// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The activity card replaces a floating eight-row list with no paging. What matters: the rows
// render in the board's job vocabulary, "Show more" walks the cursor and grows the list, the
// empty state is honest, and no dialog/overlay is involved.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { ActivityCard } from "@/components/design-project/canvas/cards/activity-card";
import { EnvironmentStatusProvider } from "@/lib/canvas/environment-status-context";
import { EMPTY_ENVIRONMENT_STATUS } from "@/lib/canvas/component-status";
import {
	type EnvironmentJobsPage,
	getEnvironmentJobs,
} from "@/app/server/actions/canvas-jobs";

vi.mock("@/app/server/actions/canvas-jobs", () => ({ getEnvironmentJobs: vi.fn() }));
vi.mock("next/navigation", () => ({ useParams: () => ({ org: "acme" }) }));

function page(ids: string[], nextCursor: string | null): EnvironmentJobsPage {
	return {
		jobs: ids.map((id, i) => ({
			id,
			type: "DEPLOY",
			status: "SUCCESS",
			createdAt: new Date(Date.UTC(2026, 8, 7, 12, 0, i)).toISOString(),
			error: null,
		})),
		nextCursor,
	};
}

function wrap(children: ReactNode) {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return (
		<QueryClientProvider client={qc}>
			<EnvironmentStatusProvider value={EMPTY_ENVIRONMENT_STATUS}>{children}</EnvironmentStatusProvider>
		</QueryClientProvider>
	);
}

beforeEach(() => {
	vi.mocked(getEnvironmentJobs).mockReset();
});

describe("ActivityCard", () => {
	it("lists the jobs and walks the cursor on Show more", async () => {
		vi.mocked(getEnvironmentJobs)
			.mockResolvedValueOnce(page(["job-1", "job-2"], "c1"))
			.mockResolvedValueOnce(page(["job-3"], null));
		render(wrap(<ActivityCard projectId="p1" environmentId="e1" />));

		expect(await screen.findAllByRole("link")).toHaveLength(2);
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

		await userEvent.setup().click(screen.getByRole("button", { name: /show more/i }));
		expect(await screen.findAllByRole("link")).toHaveLength(3);
		expect(vi.mocked(getEnvironmentJobs).mock.calls[1]?.[2]).toMatchObject({ before: "c1" });
		// The last page came back without a cursor, so there is nothing more to show.
		expect(screen.queryByRole("button", { name: /show more/i })).not.toBeInTheDocument();
	});

	it("says nothing has run when the environment has no jobs", async () => {
		vi.mocked(getEnvironmentJobs).mockResolvedValue(page([], null));
		render(wrap(<ActivityCard projectId="p1" environmentId="e1" />));
		expect(await screen.findByText(/nothing has run here yet/i)).toBeInTheDocument();
	});

	it("shows the error and offers a retry when the query fails", async () => {
		vi.mocked(getEnvironmentJobs).mockRejectedValueOnce(new Error("forbidden"));
		render(wrap(<ActivityCard projectId="p1" environmentId="e1" />));
		expect(await screen.findByText(/could not load the activity/i)).toBeInTheDocument();
		expect(screen.getByText("forbidden")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
	});
});
