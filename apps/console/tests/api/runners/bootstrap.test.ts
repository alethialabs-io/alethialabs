// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// The fleet bootstrap route (E0 0b): a VM presents its PER-VM token (validated + instance-bound via
// redeem_bootstrap_token) and gets a runner id + token; the legacy shared-env token still works as a
// dev/self-host fallback. These pin the authz branching (the SQL redeem itself is proven vs real PG).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const redeemBootstrapToken = vi.fn();
const linkBootstrapToken = vi.fn();
vi.mock("@/lib/runners/bootstrap-token", () => ({
	redeemBootstrapToken: (hash: string, instanceId: string | null) =>
		redeemBootstrapToken(hash, instanceId),
	linkBootstrapToken: (hash: string, runnerId: string) =>
		linkBootstrapToken(hash, runnerId),
}));

vi.mock("@/lib/db", () => ({ getServiceDb: vi.fn() }));
import { getServiceDb } from "@/lib/db";
import { POST } from "@/app/api/runners/bootstrap/route";

const returning = vi.fn(() => Promise.resolve([{ id: "runner-1" }]));
function mockUpsert() {
	const onConflictDoUpdate = vi.fn(() => ({ returning }));
	const values = vi.fn(() => ({ onConflictDoUpdate }));
	vi.mocked(getServiceDb).mockReturnValue({ insert: vi.fn(() => ({ values })) } as never);
}

function req(token: string | null, body: Record<string, unknown> = {}): Request {
	const headers: Record<string, string> = { "content-type": "application/json" };
	if (token) headers.authorization = `Bearer ${token}`;
	return new Request("https://console.local/api/runners/bootstrap", {
		method: "POST",
		headers,
		body: JSON.stringify(body),
	});
}

const savedShared = process.env.ALETHIA_RUNNER_BOOTSTRAP_TOKEN;
beforeEach(() => {
	vi.clearAllMocks();
	mockUpsert();
	delete process.env.ALETHIA_RUNNER_BOOTSTRAP_TOKEN;
});
afterEach(() => {
	if (savedShared === undefined) delete process.env.ALETHIA_RUNNER_BOOTSTRAP_TOKEN;
	else process.env.ALETHIA_RUNNER_BOOTSTRAP_TOKEN = savedShared;
});

describe("POST /api/runners/bootstrap", () => {
	it("401s without a bearer token", async () => {
		expect((await POST(req(null))).status).toBe(401);
		expect(redeemBootstrapToken).not.toHaveBeenCalled();
	});

	it("registers via a valid per-VM token and links it to the runner", async () => {
		redeemBootstrapToken.mockResolvedValue({ ok: true, runnerId: null });
		const res = await POST(req("vm-token", { instanceId: "vm-1", providers: ["aws"] }));
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.runner_id).toBe("runner-1");
		expect(typeof body.runner_token).toBe("string");
		expect(linkBootstrapToken).toHaveBeenCalledTimes(1);
	});

	it("falls back to the shared-env token (dev) when the token isn't in the table", async () => {
		redeemBootstrapToken.mockResolvedValue({ ok: false, runnerId: null });
		process.env.ALETHIA_RUNNER_BOOTSTRAP_TOKEN = "shared-dev-token";
		const res = await POST(req("shared-dev-token", { instanceId: "dev-1" }));
		expect(res.status).toBe(200);
		// The fallback is not a per-VM token, so nothing is linked.
		expect(linkBootstrapToken).not.toHaveBeenCalled();
	});

	it("401s when the token is neither a valid per-VM token nor the shared-env token", async () => {
		redeemBootstrapToken.mockResolvedValue({ ok: false, runnerId: null });
		process.env.ALETHIA_RUNNER_BOOTSTRAP_TOKEN = "shared-dev-token";
		expect((await POST(req("bogus", { instanceId: "vm-9" }))).status).toBe(401);
	});

	it("401s when the redeem fails and no shared-env token is configured", async () => {
		redeemBootstrapToken.mockResolvedValue({ ok: false, runnerId: null });
		expect((await POST(req("anything"))).status).toBe(401);
	});
});
