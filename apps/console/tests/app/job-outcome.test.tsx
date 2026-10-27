// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The job detail page's result block (#6134): what a successful drift scan or plan FOUND, read from
// the result the runner stored on `execution_metadata`. `SUCCESS` keeps meaning "the job ran"; the
// block's first line — its heading — is the finding.
//
// FIXTURES FOLLOW THE WIRE SHAPES, not the console's types: the drift posture is the Go
// `drift.Posture` (packages/core/drift/drift.go) as the runner serialises it; the plan result is
// `{ resource_changes }` cut from OpenTofu's `plan -json` (apps/runner/internal/agent/runner.go), or
// the whole plan document when OpenTofu omitted that key; the cost breakdown carries the top-level
// fields of the Go `infracost.CostBreakdown`. The malformed cases are plain objects because that is
// what a runner can hand the page — the reader takes `unknown`, so none of them needs a cast.

import { formatMonthlyDelta, formatMonthlyRate } from "@repo/format";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { JobOutcome } from "@/app/(private)/[org]/~/jobs/[id]/job-outcome";
import { readJobResult } from "@/app/(private)/[org]/~/jobs/[id]/job-result";

/** `n` drifted resources, alternating kinds, each naming the attribute paths that differed. */
function driftDetails(n: number) {
	return Array.from({ length: n }, (_, i) => ({
		address: `aws_security_group.sg_${i}`,
		type: "aws_security_group",
		kind: i % 2 === 0 ? "modified" : "deleted",
		...(i % 2 === 0 ? { attributes: ["ingress", "tags"] } : {}),
	}));
}

/** A drift scan that found `n` drifted resources (refresh-only: unmanaged not checked). */
function driftedPosture(n: number) {
	return {
		in_sync: false,
		drifted: n,
		details: driftDetails(n),
		normalized: 0,
		unmanaged: 0,
		unmanaged_known: false,
		scanned_at: "2026-10-20T10:00:00Z",
	};
}

const IN_SYNC = { in_sync: true, drifted: 0, normalized: 0, unmanaged: 0, unmanaged_known: false };

/** One `resource_changes` entry with the given OpenTofu actions. */
function change(address: string, actions: string[]) {
	return { address, type: "aws_instance", name: address, change: { actions, after: {}, after_unknown: {} } };
}

const PLAN_RESULT = {
	resource_changes: [
		change("aws_instance.new", ["create"]),
		change("aws_instance.tweaked", ["update"]),
		change("aws_instance.gone", ["delete"]),
		change("aws_instance.swapped", ["delete", "create"]),
		change("aws_instance.same", ["no-op"]),
	],
};

/** Renders the block for a successful job of `jobType` carrying `metadata`. */
function renderOutcome(jobType: string, metadata: unknown, status = "SUCCESS") {
	return render(<JobOutcome job={{ job_type: jobType, status, execution_metadata: metadata }} />);
}

describe("JobOutcome — a drift scan", () => {
	it("states the drifted count first and lists the first five resources", () => {
		renderOutcome("DETECT_DRIFT", { drift_posture: driftedPosture(7) });

		expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("7 resources drifted");
		const list = screen.getByRole("list", { name: "Drifted resources" });
		expect(within(list).getAllByRole("listitem")).toHaveLength(5);
		expect(within(list).getByText("aws_security_group.sg_0")).toBeInTheDocument();
		expect(within(list).queryByText("aws_security_group.sg_5")).not.toBeInTheDocument();
		expect(screen.getByText("… 2 more")).toBeInTheDocument();
	});

	it("shows each resource's kind and the attribute paths that differed", () => {
		renderOutcome("DETECT_DRIFT", { drift_posture: driftedPosture(2) });

		const [modified, deleted] = within(screen.getByRole("list", { name: "Drifted resources" })).getAllByRole(
			"listitem",
		);
		expect(modified).toHaveTextContent("Modified");
		expect(modified).toHaveTextContent("ingress, tags");
		expect(deleted).toHaveTextContent("Deleted");
		// Fewer than six: nothing to disclose.
		expect(screen.queryByRole("button", { name: /show all/i })).not.toBeInTheDocument();
	});

	it("discloses every resource behind 'Show all N', and folds them back", async () => {
		const user = userEvent.setup();
		renderOutcome("DETECT_DRIFT", { drift_posture: driftedPosture(21) });

		const toggle = screen.getByRole("button", { name: "Show all 21" });
		expect(toggle).toHaveAttribute("aria-expanded", "false");
		await user.click(toggle);

		const list = screen.getByRole("list", { name: "Drifted resources" });
		expect(within(list).getAllByRole("listitem")).toHaveLength(21);
		expect(screen.getByRole("button", { name: "Show fewer" })).toHaveAttribute("aria-expanded", "true");
		expect(screen.queryByText(/more$/)).not.toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: "Show fewer" }));
		expect(within(list).getAllByRole("listitem")).toHaveLength(5);
	});

	it("says 'in sync' when nothing drifted, and lists nothing", () => {
		renderOutcome("DETECT_DRIFT", { drift_posture: IN_SYNC });

		expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent(
			"In sync — no managed resource has drifted.",
		);
		expect(screen.queryByRole("list")).not.toBeInTheDocument();
	});

	it("never lets the count read as 'everything': a refresh-only scan says what it did not check", () => {
		renderOutcome("DETECT_DRIFT", { drift_posture: IN_SYNC });
		expect(screen.getByText("Unmanaged resources: not checked by a refresh-only scan")).toBeInTheDocument();
	});

	it("drops the caveat when unmanaged detection ran, and counts what it found", () => {
		renderOutcome("DETECT_DRIFT", { drift_posture: { ...IN_SYNC, unmanaged_known: true, unmanaged: 3 } });

		expect(screen.queryByText(/not checked by a refresh-only scan/)).not.toBeInTheDocument();
		expect(screen.getByText("3 unmanaged resources found")).toBeInTheDocument();
	});

	it("names the differences it dismissed as representational", () => {
		renderOutcome("DETECT_DRIFT", { drift_posture: { ...IN_SYNC, normalized: 9 } });
		expect(screen.getByText("9 differences dismissed as representational")).toBeInTheDocument();
	});

	it("reads a kind a newer runner invented as 'Other' rather than refusing the whole posture", () => {
		const posture = {
			...driftedPosture(1),
			details: [{ address: "aws_s3_bucket.logs", type: "aws_s3_bucket", kind: "recreated" }],
		};
		renderOutcome("DETECT_DRIFT", { drift_posture: posture });

		expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("1 resource drifted");
		expect(screen.getByRole("listitem")).toHaveTextContent("Other");
	});
});

describe("JobOutcome — a plan", () => {
	it("states the change total first, then create / update / destroy / replace", () => {
		renderOutcome("PLAN", { plan_result: PLAN_RESULT });

		expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("4 changes planned");
		expect(
			screen.getByText("+1 to create · ~1 to update · −1 to destroy · ±1 to replace"),
		).toBeInTheDocument();
	});

	it("shows the monthly cost change and the total after it", () => {
		const cost = { currency: "USD", totalMonthlyCost: "142.5", diffTotalMonthlyCost: "-12.25" };
		renderOutcome("PLAN", { plan_result: PLAN_RESULT, cost_breakdown: cost });

		// A CHANGE keeps its sign (formatMonthlyDelta); the total is a level (formatMonthlyRate).
		expect(screen.getByText(formatMonthlyDelta(-12.25, "estimate", "USD"))).toBeInTheDocument();
		expect(screen.getByText(formatMonthlyRate(142.5, "estimate", "USD"))).toBeInTheDocument();
		expect(screen.getByText(/Monthly cost change/)).toBeInTheDocument();
	});

	it("has no cost line when the plan carries no breakdown", () => {
		renderOutcome("PLAN", { plan_result: PLAN_RESULT });
		expect(screen.queryByText(/Monthly cost change|Estimated total/)).not.toBeInTheDocument();
	});

	it("falls back to dollars for a currency code Intl would throw on", () => {
		const result = readJobResult({
			job_type: "PLAN",
			status: "SUCCESS",
			execution_metadata: { plan_result: PLAN_RESULT, cost_breakdown: { currency: "us dollars", totalMonthlyCost: "10" } },
		});
		expect(result).toEqual(
			expect.objectContaining({ kind: "plan", cost: { delta: null, total: formatMonthlyRate(10, "estimate", "USD") } }),
		);
	});

	it("reads a plan document with no `resource_changes` as no changes, not as unreadable", () => {
		// OpenTofu omits the key when it is empty, and the runner then stores the whole document.
		renderOutcome("PLAN", { plan_result: { format_version: "1.2", planned_values: {} } });
		expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent(
			"No changes — the infrastructure matches the configuration.",
		);
	});
});

describe("JobOutcome — no structured result", () => {
	it.each([
		["no metadata at all", "DETECT_DRIFT", null],
		["a drift job from before the posture existed", "DETECT_DRIFT", { cluster_ready: true }],
		["a plan job with no stored plan", "PLAN", { plan_completed: true }],
		["a job type that has no result block", "DEPLOY", { drift_posture: IN_SYNC, plan_result: PLAN_RESULT }],
		["metadata that is not an object", "PLAN", "not-an-object"],
	])("keeps the plain sentence for %s", (_, jobType, metadata) => {
		renderOutcome(jobType, metadata);

		expect(screen.getByText("Job completed successfully.")).toBeInTheDocument();
		expect(screen.queryByRole("heading")).not.toBeInTheDocument();
		expect(screen.queryByText(/summary unavailable/)).not.toBeInTheDocument();
	});

	it("has no result for a job that did not succeed — a failure keeps its own panel", () => {
		expect(
			readJobResult({ job_type: "DETECT_DRIFT", status: "FAILED", execution_metadata: { drift_posture: IN_SYNC } }),
		).toBeNull();
	});
});

describe("JobOutcome — a stored result that cannot be read", () => {
	it.each([
		["a drift count that is not a number", "DETECT_DRIFT", { drift_posture: { ...IN_SYNC, drifted: "21" } }, "Drift"],
		["a posture missing its verdict", "DETECT_DRIFT", { drift_posture: { drifted: 2 } }, "Drift"],
		["a posture that is a string", "DETECT_DRIFT", { drift_posture: "drifted" }, "Drift"],
		// The Plan tab's parser degrades all three of these to "no changes"; the block must not.
		["resource_changes that is not a list", "PLAN", { plan_result: { resource_changes: "garbage" } }, "Plan"],
		["a change with no actions", "PLAN", { plan_result: { resource_changes: [{ address: "a.b" }] } }, "Plan"],
		["a plan that is neither changes nor a plan document", "PLAN", { plan_result: { hello: "world" } }, "Plan"],
	])("says the summary is unavailable for %s, and does not throw", (_, jobType, metadata, subject) => {
		renderOutcome(jobType, metadata);

		expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent(`${subject} summary unavailable`);
		expect(screen.getByText(/raw output is in the log below/)).toBeInTheDocument();
		expect(screen.queryByText(/No changes|In sync/)).not.toBeInTheDocument();
	});
});
