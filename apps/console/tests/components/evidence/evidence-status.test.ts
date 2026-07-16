// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import {
	driftMark,
	kindTone,
	receiptMark,
	securityMark,
	stageTextClass,
	verifyMark,
} from "@/components/evidence/evidence-status";
import type {
	EvidenceDrift,
	EvidenceSecurity,
	EvidenceVerify,
} from "@/lib/queries/evidence";
import type { SignedReceipt, VerifyStatus } from "@/types/jsonb.types";

/** A verify posture carrying just the verdict + optional receipt the marks read. */
function verify(
	verdict: VerifyStatus,
	receipt: SignedReceipt | null = null,
): EvidenceVerify {
	return {
		jobId: "j",
		verdict,
		evaluatedAt: new Date().toISOString(),
		hasReceipt: Boolean(receipt),
		summary: null,
		report: {
			verdict,
			catalog_version: "c",
			provider: "aws",
			controls: [],
			summary: { pass: 0, fail: 0, warn: 0, not_evaluable: 0 },
		},
		receipt,
	};
}

function receipt(algorithm: "ed25519" | "none"): SignedReceipt {
	return {
		algorithm,
		receipt: {
			version: "1",
			plan_sha256: "x",
			catalog_version: "c",
			provider: "aws",
			verdict: "pass",
			report: {
				verdict: "pass",
				catalog_version: "c",
				provider: "aws",
				controls: [],
				summary: { pass: 0, fail: 0, warn: 0, not_evaluable: 0 },
			},
		},
	};
}

describe("verifyMark", () => {
	it("maps each verdict to a tone + label", () => {
		expect(verifyMark(verify("pass"))).toMatchObject({
			label: "Verified",
			tone: "good",
		});
		expect(verifyMark(verify("warn"))).toMatchObject({
			label: "Warnings",
			tone: "warn",
		});
		expect(verifyMark(verify("fail"))).toMatchObject({
			label: "Failing",
			tone: "bad",
		});
		expect(verifyMark(verify("not_evaluable"))).toMatchObject({
			label: "Not evaluable",
			tone: "unknown",
		});
	});

	it("treats a missing verify as the honest 'Not verified' muted state", () => {
		expect(verifyMark(null)).toMatchObject({
			label: "Not verified",
			tone: "muted",
			iconKey: "shield-question",
		});
	});
});

describe("driftMark", () => {
	it("distinguishes in-sync, drifted, and never-scanned", () => {
		const inSync: EvidenceDrift = {
			inSync: true,
			drifted: 0,
			details: [],
			scannedAt: new Date().toISOString(),
		};
		const drifted: EvidenceDrift = {
			inSync: false,
			drifted: 3,
			details: [],
			scannedAt: new Date().toISOString(),
		};
		expect(driftMark(inSync)).toMatchObject({ label: "In sync", tone: "good" });
		expect(driftMark(drifted)).toMatchObject({ label: "3 drifted", tone: "bad" });
		expect(driftMark(null)).toMatchObject({ label: "Not scanned", tone: "muted" });
	});
});

describe("securityMark", () => {
	const base = {
		scannedAt: new Date().toISOString(),
		reportCount: 1,
		scanned: true,
	};
	it("surfaces the worst severity, and never a false all-clear", () => {
		const crit: EvidenceSecurity = {
			...base,
			critical: 2,
			high: 1,
			medium: 0,
			low: 0,
		};
		const high: EvidenceSecurity = {
			...base,
			critical: 0,
			high: 4,
			medium: 0,
			low: 0,
		};
		const clean: EvidenceSecurity = {
			...base,
			critical: 0,
			high: 0,
			medium: 0,
			low: 0,
		};
		const notScanned: EvidenceSecurity = {
			...base,
			scanned: false,
			critical: 0,
			high: 0,
			medium: 0,
			low: 0,
		};
		expect(securityMark(crit)).toMatchObject({ label: "2 critical", tone: "bad" });
		expect(securityMark(high)).toMatchObject({ label: "4 high", tone: "warn" });
		expect(securityMark(clean)).toMatchObject({ label: "Clean", tone: "good" });
		// scanned=false must read "Not scanned", not a clean bill of health.
		expect(securityMark(notScanned)).toMatchObject({
			label: "Not scanned",
			tone: "muted",
		});
		expect(securityMark(null)).toMatchObject({ label: "Not scanned", tone: "muted" });
	});
});

describe("receiptMark", () => {
	it("distinguishes signed / unsigned / none", () => {
		expect(receiptMark(verify("pass", receipt("ed25519")))).toMatchObject({
			label: "Signed",
			tone: "good",
		});
		expect(receiptMark(verify("pass", receipt("none")))).toMatchObject({
			label: "Unsigned",
			tone: "unknown",
		});
		expect(receiptMark(verify("pass", null))).toMatchObject({ label: "—" });
		expect(receiptMark(null)).toMatchObject({ label: "—" });
	});
});

describe("kindTone + stageTextClass", () => {
	it("scores drift kinds by sharpness", () => {
		expect(kindTone("deleted")).toBe("bad");
		expect(kindTone("modified")).toBe("warn");
		expect(kindTone("other")).toBe("unknown");
	});
	it("weights the production stage text heaviest", () => {
		expect(stageTextClass("production")).toBe("text-text-secondary");
		expect(stageTextClass("staging")).toBe("text-text-tertiary");
		expect(stageTextClass("development")).toBe("text-text-disabled");
	});
});
