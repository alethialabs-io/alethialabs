// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The engine's decisions as plain functions (lib/wizard/steps.ts): which steps are shown, where
// an issue goes, which step a request may land on, and what the server's answers about
// irreversible steps come to.

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
	checkStep,
	issuePath,
	locateFieldErrors,
	locateIssues,
	ownerField,
	resolveStepIndex,
	SETTLE_FAILED_MESSAGE,
	settleGates,
	sortIssues,
	stepIndex,
	stepperItems,
	visibleSteps,
} from "@/lib/wizard/steps";
import type { Settlement, WizardStep } from "@/lib/wizard/types";
import {
	EXAMPLE_POOL_DEFAULTS,
	type ExamplePoolValues,
	examplePoolWizard,
} from "./fixtures/example.wizard";

const STEPS = examplePoolWizard.steps;

/** Values that pass every step of the example wizard. */
const FILLED: ExamplePoolValues = { provider: "aws", region: "eu-west-1", min: 1, surge: "1", note: "" };

/** A step that owns nothing and waits on an irreversible gate answering `settlement`. */
function gateStep(id: string, settle: () => Promise<Settlement>): WizardStep<ExamplePoolValues> {
	return { id, label: id, fields: [], schema: z.object({}), gate: { kind: "irreversible", settle } };
}

/** A step that owns nothing and has no gate. */
function plainStep(id: string): WizardStep<ExamplePoolValues> {
	return { id, label: id, fields: [], schema: z.object({}) };
}

describe("visibleSteps", () => {
	it("drops a step whose `when` is false for the values", () => {
		expect(visibleSteps(STEPS, FILLED).map((step) => step.id)).toEqual([
			"cloud",
			"placement",
			"capacity",
			"review",
		]);
		expect(visibleSteps(STEPS, { ...FILLED, provider: "local" }).map((step) => step.id)).toEqual([
			"cloud",
			"capacity",
			"review",
		]);
	});
});

describe("placing an issue on a field", () => {
	it("writes an issue path the way a field path is written", () => {
		expect(issuePath(["placement", "zones", 0])).toBe("placement.zones.0");
		expect(issuePath([])).toBe("");
	});

	it("finds the field a path names, or its closest listed parent", () => {
		const fields: WizardStep<Record<string, unknown>>["fields"] = ["placement", "placement.region", "name"];
		expect(ownerField(fields, "name")).toBe("name");
		expect(ownerField(fields, "placement.region")).toBe("placement.region");
		expect(ownerField(fields, "placement.region.code")).toBe("placement.region");
		expect(ownerField(fields, "placement.zone")).toBe("placement");
		expect(ownerField(fields, "names")).toBeNull();
		expect(ownerField(fields, "")).toBeNull();
	});

	it("keeps one message per field and sets aside what no field owns", () => {
		const sorted = sortIssues<ExamplePoolValues>(
			[
				{ path: ["min"], message: "Cannot be negative" },
				{ path: ["min"], message: "A second message" },
				{ path: ["region"], message: "Pick a region" },
				{ path: [], message: "This pool cannot be created" },
			],
			["min", "surge"],
		);
		expect(sorted.fields).toEqual([{ field: "min", message: "Cannot be negative" }]);
		expect(sorted.unowned).toEqual(["Pick a region", "This pool cannot be created"]);
	});

	it("checks one step with its own schema", () => {
		const [cloud] = STEPS;
		if (cloud === undefined) throw new Error("the fixture has steps");
		expect(checkStep(cloud, FILLED)).toBeNull();
		expect(checkStep(cloud, EXAMPLE_POOL_DEFAULTS)).toEqual({
			fields: [{ field: "provider", message: "Pick a cloud" }],
			unowned: [],
		});
	});

	it("places whole-form issues on their steps, in step order", () => {
		const located = locateIssues(STEPS, [
			{ path: ["surge"], message: "At least 1" },
			{ path: ["provider"], message: "Pick a cloud" },
			{ path: [], message: "This pool cannot be created" },
			{ path: ["unknown"], message: "Nobody owns this" },
		]);
		expect(located.fields).toEqual([
			{ stepId: "cloud", field: "provider", message: "Pick a cloud" },
			{ stepId: "capacity", field: "surge", message: "At least 1" },
		]);
		expect(located.unowned).toEqual(["This pool cannot be created", "Nobody owns this"]);
	});

	it("places a server's field errors the same way", () => {
		const located = locateFieldErrors(STEPS, {
			surge: ["At least 1", "Whole numbers only"],
			provider: ["Not available on this plan"],
			region: undefined,
			note: [],
			quota: ["Your plan allows two pools"],
		});
		expect(located.fields).toEqual([
			{ stepId: "cloud", field: "provider", message: "Not available on this plan" },
			{ stepId: "capacity", field: "surge", message: "At least 1" },
		]);
		expect(located.unowned).toEqual(["Your plan allows two pools"]);
	});

	it("does not place an error on a step that is not shown", () => {
		const shown = visibleSteps(STEPS, { ...FILLED, provider: "local" });
		expect(locateFieldErrors(shown, { region: ["Pick a region"] })).toEqual({
			fields: [],
			unowned: ["Pick a region"],
		});
	});
});

describe("resolveStepIndex — the step a request may land on", () => {
	const shown = visibleSteps(STEPS, FILLED);

	/** The step id a request for `requested` lands on, for `values`. */
	function lands(requested: string | null, values: ExamplePoolValues, floorAt: string | null = null, pinnedAt: string | null = null) {
		const steps = visibleSteps(STEPS, values);
		return steps[resolveStepIndex({ steps, requested, values, floorAt, pinnedAt })]?.id;
	}

	it("is the first step for no request and for an unknown one", () => {
		expect(lands(null, FILLED)).toBe("cloud");
		expect(lands("nowhere", FILLED)).toBe("cloud");
	});

	it("is the requested step when every predecessor passes", () => {
		expect(lands("review", FILLED)).toBe("review");
		expect(lands("capacity", FILLED)).toBe("capacity");
	});

	it("is the first predecessor that does not pass", () => {
		expect(lands("review", { ...FILLED, region: "" })).toBe("placement");
		expect(lands("review", EXAMPLE_POOL_DEFAULTS)).toBe("cloud");
		expect(lands("placement", EXAMPLE_POOL_DEFAULTS)).toBe("cloud");
	});

	it("does not count a step that is not shown", () => {
		expect(lands("placement", { ...FILLED, provider: "local" })).toBe("cloud");
		expect(lands("review", { ...FILLED, provider: "local", region: "" })).toBe("review");
	});

	it("is never past the pinned step", () => {
		expect(lands("review", FILLED, null, "placement")).toBe("placement");
		expect(lands("cloud", FILLED, null, "placement")).toBe("cloud");
	});

	it("is never before the floor, and predecessors before the floor are not asked", () => {
		expect(lands("cloud", FILLED, "capacity")).toBe("capacity");
		expect(lands(null, EXAMPLE_POOL_DEFAULTS, "capacity")).toBe("capacity");
		expect(lands("review", EXAMPLE_POOL_DEFAULTS, "capacity")).toBe("review");
	});

	it("ignores a floor or a pin that names no shown step", () => {
		expect(lands("review", FILLED, "gone", "gone")).toBe("review");
	});

	it("finds a step's position", () => {
		expect(stepIndex(shown, "capacity")).toBe(2);
		expect(stepIndex(shown, "nowhere")).toBe(-1);
		expect(stepIndex(shown, null)).toBe(-1);
	});
});

describe("stepperItems", () => {
	it("marks the current step, the passed ones, the ones ahead and the ones with an error", () => {
		const shown = visibleSteps(STEPS, FILLED);
		const items = stepperItems(shown, 2, (step) => step.id === "cloud" || step.id === "capacity");
		expect(items).toEqual([
			{ id: "cloud", label: "Cloud", state: "invalid" },
			{ id: "placement", label: "Placement", state: "done" },
			{ id: "capacity", label: "Capacity", state: "current" },
			{ id: "review", label: "Review", state: "todo" },
		]);
	});
});

describe("settleGates — what the server says about irreversible steps", () => {
	it("answers nothing for a wizard with no such step", async () => {
		expect(await settleGates(STEPS)).toEqual({
			settlement: null,
			pinnedAt: null,
			floorAt: null,
			leaveFor: null,
		});
	});

	it.each<Settlement>([
		{ kind: "not-started" },
		{ kind: "in-flight", message: "Confirming your payment" },
		{ kind: "stopped", message: "The payment did not go through" },
		{ kind: "unknown", message: "We could not check" },
	])("pins the wizard at a step that answers $kind", async (settlement) => {
		const steps = [plainStep("name"), gateStep("pay", async () => settlement), plainStep("invite")];
		expect(await settleGates(steps)).toEqual({
			settlement,
			pinnedAt: "pay",
			floorAt: null,
			leaveFor: null,
		});
	});

	it("moves the floor to the step a done gate continues at", async () => {
		const done: Settlement = { kind: "done", continueAt: "invite" };
		const steps = [plainStep("name"), gateStep("pay", async () => done), plainStep("team"), plainStep("invite")];
		expect(await settleGates(steps)).toEqual({
			settlement: done,
			pinnedAt: null,
			floorAt: "invite",
			leaveFor: null,
		});
	});

	it("leaves for an absolute path a done gate names", async () => {
		const done: Settlement = { kind: "done", continueAt: "/acme/~/new" };
		const steps = [gateStep("organization", async () => done)];
		expect(await settleGates(steps)).toMatchObject({ pinnedAt: null, leaveFor: "/acme/~/new" });
	});

	it("moves past the gate, and nowhere else, for a continuation that is neither", async () => {
		for (const continueAt of ["//elsewhere.example/x", "https://elsewhere.example", "nowhere"]) {
			const done: Settlement = { kind: "done", continueAt };
			const steps = [plainStep("name"), gateStep("pay", async () => done), plainStep("invite")];
			expect(await settleGates(steps)).toMatchObject({ floorAt: "invite", leaveFor: null });
			expect(await settleGates([plainStep("name"), gateStep("pay", async () => done)])).toMatchObject({
				floorAt: "pay",
				leaveFor: null,
			});
		}
	});

	it("reads a check that throws as unknown, never as not started", async () => {
		const steps = [gateStep("pay", () => Promise.reject(new Error("network")))];
		expect(await settleGates(steps)).toEqual({
			settlement: { kind: "unknown", message: SETTLE_FAILED_MESSAGE },
			pinnedAt: "pay",
			floorAt: null,
			leaveFor: null,
		});
	});

	it("asks the gates in order and stops at the first that is not done", async () => {
		const first = vi.fn(async (): Promise<Settlement> => ({ kind: "done", continueAt: "pay" }));
		const second = vi.fn(async (): Promise<Settlement> => ({ kind: "in-flight", message: "Confirming" }));
		const third = vi.fn(async (): Promise<Settlement> => ({ kind: "not-started" }));
		const outcome = await settleGates([
			gateStep("trial", first),
			gateStep("pay", second),
			gateStep("upgrade", third),
		]);
		expect(outcome).toEqual({
			settlement: { kind: "in-flight", message: "Confirming" },
			pinnedAt: "pay",
			floorAt: "pay",
			leaveFor: null,
		});
		expect(first).toHaveBeenCalledTimes(1);
		expect(second).toHaveBeenCalledTimes(1);
		expect(third).not.toHaveBeenCalled();
	});
});
