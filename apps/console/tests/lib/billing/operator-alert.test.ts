// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// ADR 0004 C48, the module half: the operator alert lives in a server-only module that is NOT a "use
// server" file, so it is never published as a server action a client could call to page the operator.
// Its contract is `alertOperator`'s in app/server/actions/billing.ts: true only when a delivery was
// queued, false with the variable unset, and it never throws.

import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/alerts/emit", () => ({ emitAlertEvent: vi.fn(async () => 1) }));

import { emitAlertEvent } from "@/lib/alerts/emit";
import { alertOperator, OPERATOR_ALERT_EVENT, type OperatorAlert } from "@/lib/billing/operator-alert";

const SOURCE = readFileSync(path.resolve(__dirname, "../../../lib/billing/operator-alert.ts"), "utf8");

/** One alert, as a caller raises it. */
const ALERT: OperatorAlert = {
	title: "An organization has two live plans",
	subject: { type: "stripe_subscription", id: "sub_x" },
	summary: "Organization org_1 has two live plans.",
};

describe("lib/billing/operator-alert.ts (C48)", () => {
	beforeEach(() => {
		vi.mocked(emitAlertEvent).mockReset().mockResolvedValue(1);
		vi.spyOn(console, "error").mockImplementation(() => {});
	});
	afterEach(() => {
		delete process.env.ALETHIA_PLATFORM_ALERT_ORG_ID;
		vi.restoreAllMocks();
	});

	it("carries no \"use server\" directive, and is server-only", () => {
		expect(SOURCE).not.toMatch(/^\s*["']use server["']/m);
		expect(SOURCE).toMatch(/^import "server-only";$/m);
	});

	it("resolves false with ALETHIA_PLATFORM_ALERT_ORG_ID unset, and emits nothing", async () => {
		await expect(alertOperator(ALERT)).resolves.toBe(false);
		expect(emitAlertEvent).not.toHaveBeenCalled();
	});

	it("raises the payment_needs_support event on the operator's org, with the caller's subject and summary", async () => {
		process.env.ALETHIA_PLATFORM_ALERT_ORG_ID = "org_platform";
		await expect(alertOperator(ALERT)).resolves.toBe(true);
		expect(OPERATOR_ALERT_EVENT).toBe("system.platform.payment_needs_support");
		expect(emitAlertEvent).toHaveBeenCalledWith("org_platform", OPERATOR_ALERT_EVENT, {
			title: ALERT.title,
			summary: ALERT.summary,
			severity: "critical",
			resource_type: "stripe_subscription",
			resource_id: "sub_x",
		});
	});

	it("resolves false when no delivery was queued", async () => {
		process.env.ALETHIA_PLATFORM_ALERT_ORG_ID = "org_platform";
		vi.mocked(emitAlertEvent).mockResolvedValue(0);
		await expect(alertOperator(ALERT)).resolves.toBe(false);
	});

	it("never throws: a failed emit resolves false", async () => {
		process.env.ALETHIA_PLATFORM_ALERT_ORG_ID = "org_platform";
		vi.mocked(emitAlertEvent).mockRejectedValue(new Error("db down"));
		await expect(alertOperator(ALERT)).resolves.toBe(false);
	});
});
