// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6115: the PdpMemo's DEFAULT question — project `view` through the PDP's `can()`, except for a
// project that no longer exists, which is answered "yes" without asking (the job it belonged to is
// now a project-less row of its org).

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
	const rows: Array<{ id: string }> = [];
	return { rows, can: vi.fn() };
});

vi.mock("server-only", () => ({}));
vi.mock("@/lib/observability/log", () => {
	const noop = () => {};
	return { log: { child: () => ({ info: noop, warn: noop, error: noop }) } };
});
vi.mock("@/lib/authz", () => ({ getPdp: () => ({ can: h.can, enforce: vi.fn() }) }));
vi.mock("@/lib/db", () => ({
	getServiceDb: () => ({
		select: () => ({ from: () => ({ where: () => ({ limit: async () => h.rows }) }) }),
	}),
}));

import { PdpMemo } from "@/lib/realtime/pdp-memo";

const ACTOR = { userId: "22222222-2222-4222-8222-222222222222", orgId: "11111111-1111-4111-8111-111111111111" };
const PROJECT = "33333333-3333-4333-8333-333333333333";

beforeEach(() => {
	h.rows.length = 0;
	h.can.mockReset();
});

describe("PdpMemo — the default project view question", () => {
	it("asks the PDP with can() for a project that exists", async () => {
		h.rows.push({ id: PROJECT });
		h.can.mockResolvedValue({ allowed: false });
		await expect(new PdpMemo().allowed(ACTOR, PROJECT)).resolves.toBe(false);
		expect(h.can).toHaveBeenCalledWith(ACTOR, "view", { type: "project", id: PROJECT });
	});

	it("answers yes, without asking the PDP, for a project that no longer exists", async () => {
		h.can.mockResolvedValue({ allowed: false });
		await expect(new PdpMemo().allowed(ACTOR, PROJECT)).resolves.toBe(true);
		expect(h.can).not.toHaveBeenCalled();
	});
});
