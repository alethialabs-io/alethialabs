// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The promotion lifecycle and the other runner-callback modules must LOAD without auth config.
//
// lib/auth validates BETTER_AUTH_SECRET / BETTER_AUTH_URL at module load (lib/config/auth.ts), so any
// module that transitively imports it cannot even be imported by a process with no session — the
// B6.1 e2e shim (scripts/e2e/promotion-gate.ts) and the status route's service-role callbacks. That
// is exactly how B6.1 went red: the lifecycle sat in app/server/actions/promotions.ts, whose
// `authorize` import pulled lib/authz/guard → lib/auth/owner → lib/auth.
//
// tests/setup.ts sets the auth env for the whole suite, so this test UNSETS it, drops the module
// cache, and imports each module fresh. A new edge to lib/auth throws "Invalid auth configuration"
// here. The control case imports the actions file under the same conditions and expects that throw,
// so a pass cannot mean "nothing was re-evaluated".

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const AUTH_ENV = ["BETTER_AUTH_SECRET", "BETTER_AUTH_URL", "NEXT_PUBLIC_APP_URL"] as const;
const saved = new Map<string, string | undefined>();

beforeEach(() => {
	for (const k of AUTH_ENV) {
		saved.set(k, process.env[k]);
		delete process.env[k];
	}
	vi.resetModules();
});

afterEach(() => {
	for (const k of AUTH_ENV) {
		const v = saved.get(k);
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	vi.resetModules();
});

describe("runner-callback modules load without auth config", () => {
	it("lib/promotions/lifecycle", async () => {
		const mod = await import("@/lib/promotions/lifecycle");
		expect(typeof mod.advancePromotionOnPlan).toBe("function");
		expect(typeof mod.applyPromotionApproval).toBe("function");
		expect(typeof mod.finalizePromotionOnDeploy).toBe("function");
		expect(typeof mod.failPromotionForJob).toBe("function");
	});

	it("lib/jobs/finalize-deployment", async () => {
		const mod = await import("@/lib/jobs/finalize-deployment");
		expect(typeof mod.finalizeDeployment).toBe("function");
	});

	it("lib/cost/previous-environment-cost", async () => {
		const mod = await import("@/lib/cost/previous-environment-cost");
		expect(typeof mod.getPreviousEnvironmentCost).toBe("function");
	});

	it("control: the authorizing actions file DOES need auth config", async () => {
		await expect(import("@/app/server/actions/promotions")).rejects.toThrow(
			/Invalid auth configuration/,
		);
	});
});
