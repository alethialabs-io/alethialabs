// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The canvas GitOps badge precedence table (#574):
// DEGRADED > OUT OF SYNC > PROGRESSING > UNKNOWN, null when plainly healthy.

import { describe, expect, it } from "vitest";
import { gitopsBadge } from "@/lib/canvas/node-status";

describe("gitopsBadge", () => {
	it("returns null when not GitOps-managed or plainly healthy", () => {
		expect(gitopsBadge(null)).toBeNull();
		expect(gitopsBadge(undefined)).toBeNull();
		expect(gitopsBadge({ health: "Healthy", sync: "Synced" })).toBeNull();
	});

	it("degraded outranks everything", () => {
		expect(gitopsBadge({ health: "Degraded", sync: "OutOfSync" })).toEqual({
			vx: "failed",
			label: "Degraded",
		});
		expect(gitopsBadge({ health: "Missing", sync: "Synced" })).toEqual({
			vx: "failed",
			label: "Degraded",
		});
	});

	it("out of sync outranks progressing", () => {
		expect(gitopsBadge({ health: "Progressing", sync: "OutOfSync" })).toEqual({
			vx: "idle",
			label: "Out of sync",
		});
	});

	it("progressing outranks unknown", () => {
		expect(gitopsBadge({ health: "Progressing", sync: "Unknown" })).toEqual({
			vx: "pending",
			label: "Progressing",
		});
	});

	it("unknown health or sync reads as an honest Unknown", () => {
		expect(gitopsBadge({ health: "Unknown", sync: "Unknown" })).toEqual({
			vx: "disabled",
			label: "Unknown",
		});
		expect(gitopsBadge({ health: "Healthy", sync: "Unknown" })).toEqual({
			vx: "disabled",
			label: "Unknown",
		});
	});
});
