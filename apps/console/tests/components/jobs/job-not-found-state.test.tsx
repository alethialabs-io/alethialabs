// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// One exit for a job that is not there (R6 D-25). The route's `not-found.tsx` drew an `ErrorState`
// with "Go home"; the detail page drew an `EmptyState` with "Back to jobs" — one condition, two
// exits. Both lead back to this organization's jobs now. Since #7875 the route file draws that exit
// in the signed-off 404 form (`[ 404 ]`, "Nothing here.", a job-specific reason line), while the
// detail page keeps `JobNotFoundState`; this pins each to its copy and both to the one exit.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useParams: () => ({ org: "acme", id: "not-a-uuid" }) }));

import JobNotFound from "@/app/(private)/[org]/~/jobs/[id]/not-found";
import { JOB_NOT_FOUND_TITLE, JobNotFoundState } from "@/components/jobs/job-not-found-state";

const CONSOLE = join(__dirname, "..", "..", "..");

describe("the job not-found state", () => {
	it("names the job as not found and leads back to this organization's jobs", () => {
		render(<JobNotFoundState orgSlug="acme" />);
		expect(screen.getByRole("heading", { name: JOB_NOT_FOUND_TITLE })).toBeInTheDocument();
		expect(JOB_NOT_FOUND_TITLE).toBe("Job not found.");
		const back = screen.getByRole("link", { name: "Back to jobs" });
		expect(back).toHaveAttribute("href", "/acme/~/jobs");
		expect(screen.queryByRole("link", { name: /go home/i })).toBeNull();
	});

	it("the route's not-found.tsx is the 404 form with the same exit, for the organization in the address", () => {
		render(<JobNotFound />);
		expect(screen.getByRole("heading", { name: "Nothing here." })).toBeInTheDocument();
		expect(
			screen.getByText("This job doesn't exist, or it belongs to another organization.", { exact: true }),
		).toBeInTheDocument();
		expect(screen.getByRole("link", { name: "Back to jobs" })).toHaveAttribute("href", "/acme/~/jobs");
		expect(screen.queryByRole("link", { name: /go home/i })).toBeNull();
	});

	it("the detail page renders the shared state rather than its own copy of it", () => {
		const detail = readFileSync(join(CONSOLE, "app/(private)/[org]/~/jobs/[id]/job-detail.tsx"), "utf8");
		expect(detail).toContain("<JobNotFoundState orgSlug={org} />");
		expect(detail.includes('title="Job not found."')).toBe(false);
	});
});
