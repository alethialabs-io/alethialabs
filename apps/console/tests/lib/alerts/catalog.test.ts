// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import {
	CATEGORIES,
	eventMatches,
	isSecurityKey,
	labelForKey,
} from "@/lib/alerts/catalog";

describe("eventMatches", () => {
	it("matches an exact key", () => {
		expect(eventMatches("system.job.succeeded", "system.job.succeeded")).toBe(true);
		expect(eventMatches("system.job.succeeded", "system.job.failed")).toBe(false);
	});

	it("treats a trailing * as 'the rest'", () => {
		expect(eventMatches("authz.*", "authz.project.create.denied")).toBe(true);
		expect(eventMatches("authz.*", "system.job.succeeded")).toBe(false);
		expect(eventMatches("system.job.*", "system.job.succeeded")).toBe(true);
		expect(eventMatches("system.job.*", "system.runner.online")).toBe(false);
	});

	it("treats a non-trailing * as a single-segment wildcard", () => {
		expect(eventMatches("authz.*.*.denied", "authz.project.create.denied")).toBe(true);
		expect(eventMatches("authz.*.*.denied", "authz.project.create.allowed")).toBe(false);
		expect(eventMatches("authz.project.*.denied", "authz.runner.create.denied")).toBe(false);
	});

	it("rejects on a segment-count mismatch", () => {
		expect(eventMatches("a.b", "a.b.c")).toBe(false);
		expect(eventMatches("a.b.c", "a.b")).toBe(false);
	});
});

describe("cost-category live flags track real emitters", () => {
	const cost = CATEGORIES.find((c) => c.id === "cost");
	const find = (id: string) => cost?.events.find((e) => e.id === id);

	it("marks budget.threshold live — it has a shipped emitter (ai-spend-alert.ts)", () => {
		// Regression: this fires today via checkAiSpendThreshold → emitAlertEventSafe(
		// "system.cost.budget_threshold"), so it must NOT be hidden behind live:false.
		expect(find("budget.threshold")?.live).toBe(true);
	});

	it("keeps spend.spike / overage.started inert — no emitter exists yet", () => {
		expect(find("spend.spike")?.live).toBe(false);
		expect(find("overage.started")?.live).toBe(false);
	});
});

describe("isSecurityKey", () => {
	it("flags authz.* keys as security (open-core gated)", () => {
		expect(isSecurityKey("authz.project.create.denied")).toBe(true);
		expect(isSecurityKey("system.job.succeeded")).toBe(false);
	});
});

describe("labelForKey", () => {
	it("derives a friendly label for an authz key not in the catalog", () => {
		expect(labelForKey("authz.zzz.qqq.denied")).toBe("zzz · qqq denied");
		expect(labelForKey("authz.zzz.qqq.allowed")).toBe("zzz · qqq allowed");
	});

	it("falls back to the raw key when nothing matches", () => {
		expect(labelForKey("totally.unknown.key")).toBe("totally.unknown.key");
	});
});
