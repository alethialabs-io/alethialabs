// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// Best-effort writers in lib/ swallow their failure and report it once (#6649). The report goes
// through the structured logger with the caught value under `err`, so the logger's `err`
// serializer decides what is written — not `console.error`, whose `util.inspect` prints every own
// enumerable field of the error. One case per module: the alert emitter, the Activity writer, the
// hierarchy-edge mirror, the AWS price fetch and the Rekor anchor.

import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SignedReceipt } from "@/types/jsonb.types";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/alerts/rule-cache", () => ({ getEnabledRules: vi.fn() }));
vi.mock("@/lib/billing/queries", () => ({ resolveOrgEntitlements: vi.fn() }));
vi.mock("@/lib/alerts/dispatch", () => ({ dispatchDeliveries: vi.fn() }));
vi.mock("@/lib/db", () => ({ getServiceDb: vi.fn() }));
vi.mock("@/lib/enterprise", () => ({ getEnterprise: vi.fn() }));

import { getEnabledRules } from "@/lib/alerts/rule-cache";
import { emitAlertEventSafe } from "@/lib/alerts/emit";
import { recordActivity } from "@/lib/authz/activity";
import { mirrorHierarchyEdge } from "@/lib/authz/tuple-sync";
import { getServiceDb } from "@/lib/db";
import { getEnterprise } from "@/lib/enterprise";
import { log } from "@/lib/observability/log";
import { anchorReceipt } from "@/lib/evidence/receipt-anchor";
import { getRegionPrices } from "@/lib/pricing/region-prices";

/** Lets the fire-and-forget `.catch` handlers run. */
async function settle(): Promise<void> {
	for (let i = 0; i < 5; i++) await Promise.resolve();
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

/** A signed receipt with every field `canonicalReceiptJson` reads. */
function signedReceipt(): SignedReceipt {
	return {
		receipt: {
			version: "elench-receipt-1",
			plan_sha256: "abc123",
			catalog_version: "elench-controls-0.4.0",
			provider: "aws",
			verdict: "pass",
			report: {
				verdict: "pass",
				catalog_version: "elench-controls-0.4.0",
				provider: "aws",
				controls: [],
				summary: { pass: 1, fail: 0, warn: 0, not_evaluable: 0 },
			},
			evaluated_at: "2026-07-21T00:00:00Z",
		},
		algorithm: "ed25519",
		key_id: "deadbeef",
		signature: "c2ln",
	};
}

describe("best-effort writers report a swallowed failure through the logger", () => {
	it("emitAlertEventSafe logs the emit failure under err, with its event key", async () => {
		const failure = new Error("rules unavailable");
		vi.mocked(getEnabledRules).mockRejectedValue(failure);
		const error = vi.spyOn(log, "error").mockImplementation(() => {});
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

		emitAlertEventSafe("org-1", "system.test", { title: "test" });
		await settle();

		expect(error).toHaveBeenCalledWith("[alerts] emit failed (system.test)", {
			event_key: "system.test",
			err: failure,
		});
		expect(consoleError).not.toHaveBeenCalled();
	});

	it("recordActivity logs a failed Activity write under err", async () => {
		const failure = new Error("insert failed");
		const values = vi.fn(() => Promise.reject(failure));
		vi.mocked(getServiceDb).mockReturnValue({ insert: () => ({ values }) } as never);
		const error = vi.spyOn(log, "error").mockImplementation(() => {});

		recordActivity({ orgId: "org-1", userId: "u-1" } as never, "custom.event", { type: "org" });
		await settle();

		expect(values).toHaveBeenCalled();
		expect(error).toHaveBeenCalledWith("[authz] activity write failed", { err: failure });
	});

	it("mirrorHierarchyEdge logs a failed tuple write under err", async () => {
		const failure = new Error("fga down");
		vi.mocked(getEnterprise).mockReturnValue({
			tupleSync: { syncHierarchyEdge: () => Promise.reject(failure) },
		} as never);
		const error = vi.spyOn(log, "error").mockImplementation(() => {});

		mirrorHierarchyEdge("project", "p-1", "org", "org-1");
		await settle();

		expect(error).toHaveBeenCalledWith("[authz] edge tuple sync failed", { err: failure });
	});

	it("getRegionPrices logs the fetch failure under err and falls back to list prices", async () => {
		const failure = new Error("pricing api unreachable");
		vi.spyOn(global, "fetch").mockRejectedValue(failure);
		const error = vi.spyOn(log, "error").mockImplementation(() => {});

		const prices = await getRegionPrices("eu-west-1");

		expect(prices.region).toBe("eu-west-1");
		expect(error).toHaveBeenCalledWith("Failed to fetch pricing", { region: "eu-west-1", err: failure });
	});

	it("anchorReceipt logs a failed Rekor submission under err and stays fail-open", async () => {
		const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
		vi.stubEnv("ALETHIA_REKOR_ANCHOR_ENABLED", "true");
		vi.stubEnv("ALETHIA_RECEIPT_ANCHOR_KEY", privateKey.export({ type: "pkcs8", format: "pem" }).toString());
		const failure = new Error("rekor unreachable");
		vi.spyOn(global, "fetch").mockRejectedValue(failure);
		const error = vi.spyOn(log, "error").mockImplementation(() => {});

		expect(await anchorReceipt(signedReceipt())).toBeNull();

		expect(error).toHaveBeenCalledWith("[rekor] anchoring failed (fail-open, receipt stays unanchored)", {
			err: failure,
		});
	});
});
