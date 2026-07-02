// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JobWithMeta } from "@/app/server/actions/jobs";
import { JobToaster } from "@/components/shell/job-toaster";
import { makeJob } from "../fixtures/jobs";

// --- mocks ------------------------------------------------------------------

const { toast, pushMock, router, useJobsQuery } = vi.hoisted(() => {
	const toast = Object.assign(vi.fn(), {
		loading: vi.fn(),
		success: vi.fn(),
		error: vi.fn(),
		info: vi.fn(),
		dismiss: vi.fn(),
	});
	const pushMock = vi.fn();
	return { toast, pushMock, router: { push: pushMock }, useJobsQuery: vi.fn() };
});
vi.mock("sonner", () => ({ toast }));
vi.mock("next/navigation", () => ({
	useParams: () => ({ org: "acme" }),
	useRouter: () => router,
}));
vi.mock("@/lib/query/use-jobs-query", () => ({
	useJobsQuery: () => useJobsQuery(),
}));

// --- helpers ----------------------------------------------------------------

/** Renders the driver against an initial snapshot; returns a `rerender` keyed to the toaster. */
function mount(initial: JobWithMeta[] | undefined) {
	useJobsQuery.mockReturnValue({ data: initial });
	const utils = render(<JobToaster />);
	return {
		/** Feeds the next jobs snapshot and re-runs the driver effect. */
		snapshot(next: JobWithMeta[] | undefined) {
			useJobsQuery.mockReturnValue({ data: next });
			utils.rerender(<JobToaster />);
		},
	};
}

function resetToast() {
	for (const fn of [toast, toast.loading, toast.success, toast.error, toast.info]) {
		fn.mockClear();
	}
}

beforeEach(() => {
	resetToast();
	pushMock.mockClear();
});

// --- tests ------------------------------------------------------------------

describe("useJobToasts (JobToaster)", () => {
	it("is silent while seeding the baseline", () => {
		mount([makeJob({ id: "a", status: "PROCESSING" }), makeJob({ id: "b", status: "SUCCESS" })]);
		expect(toast.loading).not.toHaveBeenCalled();
		expect(toast.success).not.toHaveBeenCalled();
		expect(toast.error).not.toHaveBeenCalled();
	});

	it("never toasts a pre-existing job, even as it changes status", () => {
		const t = mount([makeJob({ id: "a", status: "PROCESSING" })]);
		t.snapshot([makeJob({ id: "a", status: "SUCCESS" })]);
		expect(toast.success).not.toHaveBeenCalled();
		expect(toast.loading).not.toHaveBeenCalled();
	});

	it("fires a loading toast for a job that starts after mount", () => {
		const t = mount([]);
		t.snapshot([makeJob({ id: "a", job_type: "DEPLOY", status: "QUEUED" })]);
		expect(toast.loading).toHaveBeenCalledTimes(1);
		const [title, opts] = toast.loading.mock.calls[0];
		expect(title).toBe("Deploying…");
		expect(opts.id).toBe("job-a");
	});

	it("morphs the loading toast into success on the same id", () => {
		const t = mount([]);
		t.snapshot([makeJob({ id: "a", status: "QUEUED" })]);
		toast.loading.mockClear();
		t.snapshot([makeJob({ id: "a", status: "SUCCESS" })]);
		expect(toast.loading).not.toHaveBeenCalled();
		expect(toast.success).toHaveBeenCalledTimes(1);
		expect(toast.success.mock.calls[0][1].id).toBe("job-a");
	});

	it("morphs into an error toast with the truncated message on failure", () => {
		const t = mount([]);
		t.snapshot([makeJob({ id: "a", status: "PROCESSING" })]);
		t.snapshot([
			makeJob({ id: "a", status: "FAILED", error_message: "boom".repeat(80) }),
		]);
		expect(toast.error).toHaveBeenCalledTimes(1);
		const opts = toast.error.mock.calls[0][1];
		expect(opts.id).toBe("job-a");
		expect(opts.description).toHaveLength(140);
	});

	it("shows a single success toast for a job seen first as already-SUCCESS (fast poll)", () => {
		const t = mount([]);
		t.snapshot([makeJob({ id: "a", status: "SUCCESS" })]);
		expect(toast.loading).not.toHaveBeenCalled();
		expect(toast.success).toHaveBeenCalledTimes(1);
		expect(toast.success.mock.calls[0][1].id).toBe("job-a");
	});

	it("resolves a cancelled job to a neutral toast on the same id", () => {
		const t = mount([]);
		t.snapshot([makeJob({ id: "a", status: "PROCESSING" })]);
		t.snapshot([makeJob({ id: "a", status: "CANCELLED" })]);
		expect(toast).toHaveBeenCalledTimes(1);
		const [title, opts] = toast.mock.calls[0];
		expect(title).toBe("Deploy cancelled");
		expect(opts.id).toBe("job-a");
		expect(toast.success).not.toHaveBeenCalled();
		expect(toast.error).not.toHaveBeenCalled();
	});

	it("does not re-emit when the same snapshot repeats", () => {
		const t = mount([]);
		const running = [makeJob({ id: "a", status: "PROCESSING" })];
		t.snapshot(running);
		t.snapshot(running);
		t.snapshot(running);
		expect(toast.loading).toHaveBeenCalledTimes(1);
	});

	it("ignores internal/background job types entirely", () => {
		const t = mount([]);
		t.snapshot([makeJob({ id: "a", job_type: "DETECT_DRIFT", status: "QUEUED" })]);
		t.snapshot([makeJob({ id: "a", job_type: "DETECT_DRIFT", status: "SUCCESS" })]);
		t.snapshot([makeJob({ id: "b", job_type: "ANALYZE_REPO", status: "PROCESSING" })]);
		expect(toast.loading).not.toHaveBeenCalled();
		expect(toast.success).not.toHaveBeenCalled();
	});

	it("navigates org-scoped (client push) from the View job action", () => {
		const t = mount([]);
		t.snapshot([makeJob({ id: "a", status: "SUCCESS" })]);
		const action = toast.success.mock.calls[0][1].action;
		action.onClick();
		expect(pushMock).toHaveBeenCalledWith("/acme/~/jobs/a");
	});

	it("toasts the genuinely-first job when the first snapshot was empty (regression)", () => {
		const t = mount(undefined); // query not settled
		t.snapshot([]); // first settled snapshot is empty → baseline
		t.snapshot([makeJob({ id: "a", status: "QUEUED" })]); // first ever job
		expect(toast.loading).toHaveBeenCalledTimes(1);
		expect(toast.loading.mock.calls[0][1].id).toBe("job-a");
	});

	it("keeps a single toast across progressive active sub-states", () => {
		const t = mount([]);
		t.snapshot([makeJob({ id: "a", status: "QUEUED" })]);
		t.snapshot([makeJob({ id: "a", status: "CLAIMED" })]);
		t.snapshot([makeJob({ id: "a", status: "PROCESSING" })]);
		expect(toast.loading).toHaveBeenCalledTimes(3);
		// Same id every time → one toast updated in place, not three stacked.
		for (const call of toast.loading.mock.calls) {
			expect(call[1].id).toBe("job-a");
		}
		expect(toast.success).not.toHaveBeenCalled();
	});
});
