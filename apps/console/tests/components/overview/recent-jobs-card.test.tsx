// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Locks the fetch-error UX (#707): a failed jobs query must render the error affordance, NOT the
// "No jobs yet" empty state (which would tell the user they have no jobs when the request failed).

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { q } = vi.hoisted(() => ({
	q: {
		data: [] as unknown[],
		isPending: false,
		isError: false,
		refetch: vi.fn(),
	},
}));
vi.mock("@/lib/query/use-jobs-query", () => ({ useJobsQuery: () => q }));

import { RecentJobsCard } from "@/components/overview/recent-jobs-card";

beforeEach(() => {
	q.data = [];
	q.isPending = false;
	q.isError = false;
	q.refetch = vi.fn();
});

describe("RecentJobsCard fetch-error state", () => {
	it("shows an error (not 'No jobs yet') on a fetch failure, and retries", () => {
		q.isError = true;
		render(<RecentJobsCard orgSlug="acme" />);
		expect(screen.getByText(/Couldn't load recent jobs/i)).toBeInTheDocument();
		expect(screen.queryByText(/No jobs yet/i)).not.toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: /retry/i }));
		expect(q.refetch).toHaveBeenCalledTimes(1);
	});

	it("shows the empty state when the fetch succeeds with no jobs", () => {
		render(<RecentJobsCard orgSlug="acme" />);
		expect(screen.getByText(/No jobs yet/i)).toBeInTheDocument();
		expect(screen.queryByText(/Couldn't load/i)).not.toBeInTheDocument();
	});

	it("shows neither error nor empty while the first fetch is pending", () => {
		q.isPending = true;
		render(<RecentJobsCard orgSlug="acme" />);
		expect(screen.queryByText(/No jobs yet/i)).not.toBeInTheDocument();
		expect(screen.queryByText(/Couldn't load/i)).not.toBeInTheDocument();
	});
});
