// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #4990: the webhook-CA marker must reach the create input through the REAL create path.
// The action tests pass the marker straight to createProject; this pins that the template
// picker's buildCreateInput is what sets it — the gap a review found in #5002.

import { describe, expect, it } from "vitest";
import { buildCreateInput } from "@/components/create-project/templates";

/** A create input for `template` on aws with one default environment. */
function inputFor(template: "standard" | "ai" | "custom") {
	return buildCreateInput({
		projectName: "p",
		template,
		provider: "aws",
		cloudIdentityId: "00000000-0000-0000-0000-000000000001",
		defaultEnvironment: { name: "production", stage: "production", region: "eu-west-1" },
	});
}

describe("buildCreateInput — webhook-CA consumers (#4990)", () => {
	it("the AI template declares kserve, so the deploy installs cert-manager issuer-free", () => {
		expect(inputFor("ai").project.webhook_ca_consumers).toEqual(["kserve"]);
	});

	it("the other templates omit the key entirely, so their input is unchanged", () => {
		expect("webhook_ca_consumers" in inputFor("standard").project).toBe(false);
		expect("webhook_ca_consumers" in inputFor("custom").project).toBe(false);
	});
});
