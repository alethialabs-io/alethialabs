// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { matchesRule, meetsSeverity } from "@/lib/alerts/events";
import type {
	AlertEventContext,
	AlertRuleMatch,
} from "@/types/jsonb.types";

describe("meetsSeverity", () => {
	it("is true only when actual ≥ floor", () => {
		expect(meetsSeverity("critical", "warning")).toBe(true);
		expect(meetsSeverity("warning", "warning")).toBe(true);
		expect(meetsSeverity("info", "warning")).toBe(false);
		expect(meetsSeverity("info", "info")).toBe(true);
	});
});

describe("matchesRule", () => {
	const ctx: AlertEventContext = {
		title: "Deploy succeeded",
		job_type: "DEPLOY",
		project_id: "project-1",
	};

	it("passes an empty match (no constraints)", () => {
		const match: AlertRuleMatch = {};
		expect(matchesRule(match, ctx, "info")).toBe(true);
	});

	it("ANDs each present field-equality set", () => {
		expect(matchesRule({ job_types: ["DEPLOY"] }, ctx, "info")).toBe(true);
		expect(matchesRule({ job_types: ["PLAN"] }, ctx, "info")).toBe(false);
		// A constraint on a field the context lacks fails.
		expect(matchesRule({ actions: ["create"] }, ctx, "info")).toBe(false);
		// Two constraints both satisfied.
		expect(matchesRule({ job_types: ["DEPLOY"], project_ids: ["project-1"] }, ctx, "info")).toBe(true);
		expect(matchesRule({ job_types: ["DEPLOY"], project_ids: ["project-9"] }, ctx, "info")).toBe(false);
	});

	it("enforces min_severity against the effective severity", () => {
		expect(matchesRule({ min_severity: "critical" }, ctx, "warning")).toBe(false);
		expect(matchesRule({ min_severity: "warning" }, ctx, "critical")).toBe(true);
	});
});
