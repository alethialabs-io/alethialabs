// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The setup guide's steps (#6817). The deploy step used to link to the organization's overview,
// which is usually the page the guide is open on and has no way to deploy anything. It now leads
// to where a deploy is started: the first project's Architecture page.

import { describe, expect, it, vi } from "vitest";

// The guide's stores read the query cache and the workspace; the step builder under test is pure.
vi.mock("@/lib/rpc/client", () => ({ orpc: {} }));
vi.mock("@/lib/stores/use-workspace-store", () => ({ useActiveOrgSlug: () => "acme" }));

import type { GettingStartedState } from "@/app/server/actions/onboarding";
import { getSetupSteps } from "@/components/onboarding/setup-guide";

/** An organization that has done nothing yet, on a plan that can invite. */
const FRESH: GettingStartedState = {
	hasCloud: false,
	hasProject: false,
	hasProvisioned: false,
	canInvite: true,
	memberCount: 1,
};

/** The step with this key, or a failure naming the keys there are. */
function step(steps: ReturnType<typeof getSetupSteps>, key: string) {
	const found = steps.find((s) => s.key === key);
	if (!found) throw new Error(`no "${key}" step among ${steps.map((s) => s.key).join(", ")}`);
	return found;
}

describe("getSetupSteps", () => {
	it("has no steps until the organization's state has loaded", () => {
		expect(getSetupSteps("acme", null, null)).toEqual([]);
	});

	it("the deploy step leads to the first project's Architecture page", () => {
		const steps = getSetupSteps("acme", { ...FRESH, hasCloud: true, hasProject: true }, "shop");
		expect(step(steps, "provision").href).toBe("/acme/shop/architecture");
	});

	it("with no project yet, the deploy step leads to creating one — never to the overview", () => {
		const steps = getSetupSteps("acme", FRESH, null);
		expect(step(steps, "provision").href).toBe("/acme/~/new");
		expect(steps.map((s) => s.href)).not.toContain("/acme");
	});

	it("the first step opens the connectors page on its cloud connectors", () => {
		expect(step(getSetupSteps("acme", FRESH, null), "cloud").href).toBe("/acme/~/connectors?type=cloud");
	});

	it("names no cloud: which clouds are offered is the server's answer, not this list's", () => {
		const copy = getSetupSteps("acme", FRESH, null)
			.map((s) => `${s.title} ${s.desc}`)
			.join(" ");
		const named = ["AWS", "GCP", "Azure", "Alibaba", "Hetzner", "DigitalOcean", "Civo"].filter((cloud) =>
			copy.includes(cloud),
		);
		expect(named).toEqual([]);
	});

	it("uses the console's words: a cloud account is connected, an environment is deployed", () => {
		const steps = getSetupSteps("acme", FRESH, null);
		expect(step(steps, "cloud").title).toBe("Connect a cloud account");
		expect(step(steps, "provision").title).toBe("Deploy your first environment");
	});

	it("ticks each step from the organization's real state", () => {
		const steps = getSetupSteps("acme", { ...FRESH, hasCloud: true, hasProject: true, memberCount: 2 }, "shop");
		expect(steps.map((s) => [s.key, s.done])).toEqual([
			["cloud", true],
			["project", true],
			["provision", false],
			["invite", true],
		]);
	});

	it("leaves the invite step out on a plan that cannot invite", () => {
		const steps = getSetupSteps("acme", { ...FRESH, canInvite: false }, null);
		expect(steps.map((s) => s.key)).toEqual(["cloud", "project", "provision"]);
	});
});
