// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6818 — a plan somebody has asked to deploy or destroy from. The request waits on a PERSON for up
// to the organization's approval window (60 minutes by default), with no job to show for it. The
// plan's page has to say that the wait is on a person, how long it has left, and what became of it —
// or a finished plan with nothing happening reads as something stuck.

import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JobApprovalNotice, approvalStanding } from "@/app/(private)/[org]/~/jobs/[id]/job-approval";
import type { JobApproval } from "@/lib/rpc/procedures/jobs";

const REQUESTED = new Date("2026-11-20T10:00:00.000Z");
const EXPIRES = new Date("2026-11-20T11:00:00.000Z");

/** A request to deploy, pending unless told otherwise. */
function approval(fields: Partial<JobApproval> = {}): JobApproval {
	return {
		operation: "deploy",
		status: "pending",
		requested_at: REQUESTED.toISOString(),
		expires_at: EXPIRES.toISOString(),
		decided_at: null,
		consumed_job_id: null,
		...fields,
	};
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
	// Seventeen minutes into the hour the request stays open.
	vi.setSystemTime(new Date("2026-11-20T10:17:00.000Z"));
});
afterEach(() => {
	vi.useRealTimers();
});

describe("approvalStanding", () => {
	it("a pending request is waiting until its time is up, and expired from then on", () => {
		expect(approvalStanding(approval(), EXPIRES.getTime() - 1)).toBe("waiting");
		expect(approvalStanding(approval(), EXPIRES.getTime())).toBe("expired");
	});

	it("before the clock has been read a pending request reads as waiting", () => {
		expect(approvalStanding(approval(), null)).toBe("waiting");
	});

	it.each([
		["approved", "approved"],
		["consumed", "started"],
		["rejected", "rejected"],
		["expired", "expired"],
		["superseded", "superseded"],
	] as const)("%s reads %s, whatever the clock says", (status, standing) => {
		expect(approvalStanding(approval({ status }), EXPIRES.getTime() + 60_000)).toBe(standing);
		expect(approvalStanding(approval({ status }), null)).toBe(standing);
	});
});

describe("the notice on a plan's page", () => {
	it("waiting: says it waits on a person, that nothing is stuck, and how long the request has left", () => {
		render(<JobApprovalNotice approval={approval()} org="acme" />);
		const notice = screen.getByRole("status");
		expect(notice).toHaveTextContent("Waiting for approval");
		expect(notice).toHaveTextContent("A deploy from this plan was requested 17 minutes ago.");
		expect(notice).toHaveTextContent("waiting for a person to approve it");
		expect(notice).toHaveTextContent("nothing is stuck");
		expect(notice).toHaveTextContent("The request stays open for 43 min more.");
	});

	it("names the operation that was asked for", () => {
		render(<JobApprovalNotice approval={approval({ operation: "destroy" })} org="acme" />);
		expect(screen.getByRole("status")).toHaveTextContent("A destroy from this plan was requested");
	});

	it("a request whose time is up says it expired and that nothing was changed — never 'waiting'", () => {
		vi.setSystemTime(new Date("2026-11-20T11:00:01.000Z"));
		render(<JobApprovalNotice approval={approval()} org="acme" />);
		const notice = screen.getByRole("status");
		expect(notice).toHaveTextContent("Approval request expired");
		expect(notice).toHaveTextContent("nothing was changed");
		expect(notice).not.toHaveTextContent("Waiting for approval");
	});

	it("approved and not started yet", () => {
		render(
			<JobApprovalNotice
				approval={approval({ status: "approved", decided_at: "2026-11-20T10:12:00.000Z" })}
				org="acme"
			/>,
		);
		const notice = screen.getByRole("status");
		expect(notice).toHaveTextContent("Approved — not started yet");
		expect(notice).toHaveTextContent("The deploy from this plan was approved 5 minutes ago.");
	});

	it("used: links to the job the approval started", () => {
		render(
			<JobApprovalNotice
				approval={approval({ status: "consumed", consumed_job_id: "22222222-2222-4222-8222-222222222222" })}
				org="acme"
			/>,
		);
		expect(screen.getByRole("status")).toHaveTextContent("Approved — the deploy has started");
		expect(screen.getByRole("link", { name: "View the deploy job" })).toHaveAttribute(
			"href",
			"/acme/~/jobs/22222222-2222-4222-8222-222222222222",
		);
	});

	it.each([
		["rejected", "Approval rejected"],
		["superseded", "Approval request replaced"],
	] as const)("%s says so, and that nothing was changed", (status, title) => {
		render(<JobApprovalNotice approval={approval({ status })} org="acme" />);
		const notice = screen.getByRole("status");
		expect(notice).toHaveTextContent(title);
		expect(notice).toHaveTextContent("Nothing was changed.");
	});
});
