// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6818 (D-13) — one duration wording for the jobs list and a job's own page. They used to decide it
// separately, so a plan cancelled after 120 days in the queue read "Never started" on its page and
// as a 120-day run in the list. Both now read `readJobDuration`.

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/components/runners/release-notes-popover", () => ({ ReleaseNotesPopover: () => null }));

import { JobDuration, type JobTimes, readJobDuration } from "@/components/jobs/columns";

const CREATED = "2026-07-19T10:00:00.000Z";
/** 120 days and 19 minutes after CREATED. */
const COMPLETED = "2026-11-16T10:19:00.000Z";
const WAIT_MS = new Date(COMPLETED).getTime() - new Date(CREATED).getTime();

/** A job's times; each case sets what it needs. */
const job = (fields: Partial<JobTimes>): JobTimes => ({
	status: "SUCCESS",
	created_at: CREATED,
	started_at: null,
	completed_at: null,
	...fields,
});

describe("readJobDuration", () => {
	it("a job that finished without starting never ran: its span is a wait", () => {
		expect(readJobDuration(job({ status: "CANCELLED", completed_at: COMPLETED }))).toEqual({
			kind: "never-started",
			waitedMs: WAIT_MS,
		});
	});

	it("a job that started and finished ran for the span", () => {
		expect(
			readJobDuration(job({ started_at: "2026-07-19T10:01:00.000Z", completed_at: COMPLETED })),
		).toEqual({ kind: "ran", ms: WAIT_MS });
	});

	it.each(["QUEUED", "CLAIMED", "PROCESSING"])("a %s job is live since it was created", (status) => {
		expect(readJobDuration(job({ status }))).toEqual({ kind: "live", since: CREATED });
	});

	it("a finished job with no completion time has nothing to state — it does not tick", () => {
		expect(readJobDuration(job({ status: "FAILED" }))).toEqual({ kind: "none" });
	});

	it("a job with no creation time has nothing to state", () => {
		expect(readJobDuration(job({ created_at: null, completed_at: COMPLETED }))).toEqual({ kind: "none" });
	});
});

describe("JobDuration", () => {
	const NEVER_STARTED = job({ status: "CANCELLED", completed_at: COMPLETED });

	it("the list says a job never started, and does not print its wait as a run", () => {
		render(<JobDuration job={NEVER_STARTED} />);
		expect(screen.getByText("Never started")).toBeInTheDocument();
		expect(screen.queryByText(/120d/)).toBeNull();
	});

	it("the job's page says the same, and how long it waited", () => {
		render(<JobDuration job={NEVER_STARTED} detail />);
		expect(screen.getByText("Never started · waited 120d 0h")).toBeInTheDocument();
	});

	it("a job that ran reads the same span in both", () => {
		const ran = job({ started_at: "2026-07-19T10:01:00.000Z", completed_at: "2026-07-19T10:03:30.000Z" });
		const list = render(<JobDuration job={ran} />);
		const inList = list.container.textContent;
		list.unmount();
		const page = render(<JobDuration job={ran} detail />);
		expect(page.container.textContent).toBe(inList);
		expect(inList).toBe("3m 30s");
	});

	it("renders nothing when there is nothing to state", () => {
		const { container } = render(<JobDuration job={job({ status: "FAILED" })} />);
		expect(container).toBeEmptyDOMElement();
	});
});
