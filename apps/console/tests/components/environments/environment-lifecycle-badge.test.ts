// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6736: the environment card's badge says what the environment's OWN lifecycle says. It used to read
// "Deploying" whenever the design had moved ahead of the last deploy — an unsaved edit with no job at
// all — so an environment read as deploying for as long as an edit stayed undeployed.

import { describe, expect, it } from "vitest";
import { envLifecycleBadge } from "@/components/environments/environment-card";

describe("envLifecycleBadge", () => {
	it.each([
		["QUEUED", "pending", "Queued"],
		["PROVISIONING", "live", "Deploying"],
		["DESTROYING", "live", "Tearing down"],
		["FAILED", "failed", "Failed"],
		["DRAFT", "idle", "Draft"],
		["DESTROYED", "disabled", "Destroyed"],
		["ACTIVE", "active", "Live"],
	])("%s reads as %s / %s", (status, tier, label) => {
		expect(envLifecycleBadge(status)).toEqual({ tier, label });
	});
});
