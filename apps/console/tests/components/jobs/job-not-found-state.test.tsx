// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// One "Job not found." (R6 D-25). The route's `not-found.tsx` drew an `ErrorState` with "Go home";
// the detail page drew an `EmptyState` with "Back to jobs" — one condition, two exits. Both render
// `JobNotFoundState` now; this pins the route file to it and the component to its one exit.

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

	it("the route's not-found.tsx is the same state, for the organization in the address", () => {
		render(<JobNotFound />);
		expect(screen.getByRole("heading", { name: JOB_NOT_FOUND_TITLE })).toBeInTheDocument();
		expect(screen.getByRole("link", { name: "Back to jobs" })).toHaveAttribute("href", "/acme/~/jobs");
	});

	it("the detail page renders the shared state rather than its own copy of it", () => {
		const detail = readFileSync(join(CONSOLE, "app/(private)/[org]/~/jobs/[id]/job-detail.tsx"), "utf8");
		expect(detail).toContain("<JobNotFoundState orgSlug={org} />");
		expect(detail.includes('title="Job not found."')).toBe(false);
	});
});
