// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6736: the environment's badge says what the environment's OWN lifecycle says. It used to read
// "Deploying" whenever the design had moved ahead of the last deploy — an unsaved edit with no job at
// all — so an environment read as deploying for as long as an edit stayed undeployed.

import { describe, expect, it } from "vitest";
import { envLifecycleBadge, mayHoldResources, stageLabel } from "@/components/environments/environment-status";

describe("envLifecycleBadge", () => {
	it.each([
		["QUEUED", "pending", "Queued"],
		["PROVISIONING", "live", "Deploying"],
		["DESTROYING", "live", "Destroying"],
		["FAILED", "failed", "Failed"],
		["DRAFT", "idle", "Draft"],
		["DESTROYED", "disabled", "Destroyed"],
		["ACTIVE", "active", "Live"],
	])("%s reads as %s / %s", (status, tier, label) => {
		expect(envLifecycleBadge(status)).toEqual({ tier, label });
	});
});

describe("mayHoldResources", () => {
	it("only a FAILED environment is said to maybe hold resources — the status the delete guard lets through", () => {
		expect(mayHoldResources("FAILED")).toBe(true);
		for (const status of ["DRAFT", "QUEUED", "PROVISIONING", "ACTIVE", "DESTROYING", "DESTROYED"]) {
			expect(mayHoldResources(status)).toBe(false);
		}
	});
});

describe("stageLabel", () => {
	it("names the three stages, and prints any other as it is", () => {
		expect(["development", "staging", "production"].map(stageLabel)).toEqual(["Development", "Staging", "Production"]);
		expect(stageLabel("canary")).toBe("canary");
	});
});
