// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The view-state URL codec (lib/query/view-url-params.ts): which overlay is open and which step
// is shown. It reads through the filter codec's `ParamReader`, so the same decode serves a server
// component's `searchParams` and a client's `useSearchParams()` — both are exercised here.

import { describe, expect, it } from "vitest";
import { paramReader } from "@/lib/query/filter-url-codec";
import {
	applyParamPatch,
	hrefWithParamPatch,
	isViewId,
	isWizardOpenInUrl,
	readViewParam,
	STEP_PARAM,
	WIZARD_PARAM,
	type WizardUrlShape,
	wizardClearPatch,
	wizardStepFromUrl,
	wizardStepPatch,
} from "@/lib/query/view-url-params";

const PAGE: WizardUrlShape = { id: "create-project", presentation: "page" };
const OVERLAY: WizardUrlShape = { id: "fleet-pool", presentation: "overlay" };

describe("isViewId", () => {
	it("accepts short identifiers", () => {
		for (const id of ["cloud", "path-ref", "step_2", "A1"]) expect(isViewId(id)).toBe(true);
	});

	it("refuses anything else", () => {
		for (const id of ["", "-lead", "a b", "a/b", "../x", "a.b", "a:b", "x".repeat(65)]) {
			expect(isViewId(id)).toBe(false);
		}
	});
});

describe("reading", () => {
	it("decodes the same from a client reader and a server searchParams record", () => {
		const client = new URLSearchParams("wizard=fleet-pool&step=capacity");
		const server = paramReader({ wizard: "fleet-pool", step: ["capacity", "review"] });
		for (const params of [client, server]) {
			expect(readViewParam(params, WIZARD_PARAM)).toBe("fleet-pool");
			expect(isWizardOpenInUrl(params, "fleet-pool")).toBe(true);
			expect(wizardStepFromUrl(params, OVERLAY)).toBe("capacity");
		}
	});

	it("reads an absent or malformed param as absent", () => {
		expect(readViewParam(new URLSearchParams(""), STEP_PARAM)).toBeNull();
		expect(readViewParam(new URLSearchParams("step=a%2Fb"), STEP_PARAM)).toBeNull();
		expect(readViewParam(new URLSearchParams("step="), STEP_PARAM)).toBeNull();
	});

	it("reads a page wizard's step whatever ?wizard= says", () => {
		expect(wizardStepFromUrl(new URLSearchParams("step=review"), PAGE)).toBe("review");
		expect(wizardStepFromUrl(new URLSearchParams("wizard=other&step=review"), PAGE)).toBe("review");
		expect(wizardStepFromUrl(new URLSearchParams(""), PAGE)).toBeNull();
	});

	it("reads an overlay's step only while the URL names that overlay", () => {
		expect(wizardStepFromUrl(new URLSearchParams("step=capacity"), OVERLAY)).toBeNull();
		expect(wizardStepFromUrl(new URLSearchParams("wizard=other&step=capacity"), OVERLAY)).toBeNull();
		expect(isWizardOpenInUrl(new URLSearchParams("wizard=other"), "fleet-pool")).toBe(false);
		expect(wizardStepFromUrl(new URLSearchParams("wizard=fleet-pool"), OVERLAY)).toBeNull();
	});
});

describe("patches", () => {
	it("a page wizard's step patch names the step only", () => {
		expect(wizardStepPatch(PAGE, "review")).toEqual({ step: "review" });
		expect(wizardStepPatch(PAGE, null)).toEqual({ step: null });
	});

	it("an overlay's step patch also names the overlay", () => {
		expect(wizardStepPatch(OVERLAY, "capacity")).toEqual({ wizard: "fleet-pool", step: "capacity" });
	});

	it("the clear patch removes what the wizard owns, with the params its steps kept", () => {
		expect(wizardClearPatch(PAGE)).toEqual({ step: null });
		expect(wizardClearPatch(PAGE, ["scan"])).toEqual({ step: null, scan: null });
		expect(wizardClearPatch(OVERLAY, ["scan"])).toEqual({ step: null, wizard: null, scan: null });
	});

	it("applies a patch and leaves unnamed params as they are", () => {
		expect(applyParamPatch("status=active&step=cloud", { step: "review" })).toBe(
			"status=active&step=review",
		);
		expect(applyParamPatch("status=active&step=cloud", { step: null })).toBe("status=active");
		expect(applyParamPatch("?scan=abc", { wizard: "fleet-pool", step: "cloud" })).toBe(
			"scan=abc&wizard=fleet-pool&step=cloud",
		);
		expect(applyParamPatch("step=cloud", { step: null })).toBe("");
	});

	it("builds an href with and without a query", () => {
		expect(hrefWithParamPatch("/acme/~/new", "", { step: "review" })).toBe("/acme/~/new?step=review");
		expect(hrefWithParamPatch("/acme/~/new", "step=review", { step: null })).toBe("/acme/~/new");
	});
});
