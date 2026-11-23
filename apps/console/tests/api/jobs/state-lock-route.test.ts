// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveStateRequest = vi.fn();
vi.mock("@/lib/runners/state-auth", () => ({
	resolveStateRequest: (...a: unknown[]) => resolveStateRequest(...a),
}));

const acquireStateLock = vi.fn();
const releaseStateLock = vi.fn();
vi.mock("@/lib/runners/state-lock", () => ({
	acquireStateLock: (...a: unknown[]) => acquireStateLock(...a),
	releaseStateLock: (...a: unknown[]) => releaseStateLock(...a),
}));

import { DELETE, POST } from "@/app/api/jobs/[id]/state/lock/route";

const KEY = "projects/p-1/e-1/tofu.tfstate";

/** A lock call whose URL names `pathJobId` (a Plan→Apply names the PLAN). */
function call(method: "POST" | "DELETE", pathJobId: string, body: unknown) {
	return [
		new Request("https://x/s/lock", { method, body: JSON.stringify(body) }),
		{ params: Promise.resolve({ id: pathJobId }) },
	] as const;
}

beforeEach(() => {
	vi.clearAllMocks();
	acquireStateLock.mockResolvedValue({ acquired: true, holder: null });
	releaseStateLock.mockResolvedValue(true);
});

describe("state lock route", () => {
	// #7290: a DEPLOY reusing a PLAN's saved artifact talks to the PLAN's URL with its own token. The
	// lock used to be filed under the PLAN, so the DEPLOY's terminal report (which releases the locks
	// ITS job holds) never found it, and a cancelled apply stranded the lock for the full TTL.
	it("files the lock under the TOKEN's job, not the job named in the URL", async () => {
		resolveStateRequest.mockResolvedValue({ stateKey: KEY, jobId: "deploy-1" });
		const res = await POST(...call("POST", "plan-1", { ID: "lock-1" }));
		expect(res.status).toBe(200);
		expect(acquireStateLock).toHaveBeenCalledWith(KEY, "lock-1", "deploy-1", { ID: "lock-1" });
	});

	it("does not let a cancelled job take a NEW lock (acquire does not opt in)", async () => {
		resolveStateRequest.mockResolvedValue({ stateKey: KEY, jobId: "deploy-1" });
		await POST(...call("POST", "deploy-1", { ID: "lock-1" }));
		expect(resolveStateRequest).toHaveBeenCalledWith(expect.any(Request), "deploy-1");
	});

	it("423s with the holder's info on contention", async () => {
		resolveStateRequest.mockResolvedValue({ stateKey: KEY, jobId: "deploy-1" });
		acquireStateLock.mockResolvedValue({ acquired: false, holder: { ID: "other" } });
		const res = await POST(...call("POST", "deploy-1", { ID: "lock-1" }));
		expect(res.status).toBe(423);
		expect(await res.json()).toEqual({ ID: "other" });
	});

	// The unlock is the last call an interrupted apply makes, and it arrives after the cancel flip.
	it("lets the cancelled lock holder unlock (DELETE opts into the cancelled-holder admission)", async () => {
		resolveStateRequest.mockResolvedValue({ stateKey: KEY, jobId: "deploy-1" });
		const res = await DELETE(...call("DELETE", "deploy-1", { ID: "lock-1" }));
		expect(res.status).toBe(200);
		expect(resolveStateRequest).toHaveBeenCalledWith(expect.any(Request), "deploy-1", {
			allowCancelledHolder: true,
		});
		expect(releaseStateLock).toHaveBeenCalledWith(KEY, "lock-1");
	});

	it("propagates an auth refusal and releases nothing", async () => {
		resolveStateRequest.mockResolvedValue({
			error: NextResponse.json({ error: "no" }, { status: 409 }),
		});
		const res = await DELETE(...call("DELETE", "deploy-1", { ID: "lock-1" }));
		expect(res.status).toBe(409);
		expect(releaseStateLock).not.toHaveBeenCalled();
	});
});
