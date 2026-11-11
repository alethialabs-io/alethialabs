// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6541 — "redeploy to apply": the setting is pending when it differs from what the latest deploy
// CARRIED. No deploy yet is not pending (the first one carries it); a deploy from before the key
// carried no setting, which reads as off.

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ getServiceDb: vi.fn() }));

import { byoAdmissionPending } from "@/lib/environments/byo-admission-state";

describe("byoAdmissionPending", () => {
	it("is pending exactly when the latest deploy carried another value", () => {
		expect(byoAdmissionPending(true, false)).toBe(true);
		expect(byoAdmissionPending(false, true)).toBe(true);
		expect(byoAdmissionPending(true, true)).toBe(false);
		expect(byoAdmissionPending(false, false)).toBe(false);
	});

	it("reads a deploy that carried no key as off, and no deploy as nothing to re-apply", () => {
		expect(byoAdmissionPending(true, undefined)).toBe(true);
		expect(byoAdmissionPending(false, undefined)).toBe(false);
		expect(byoAdmissionPending(true, null)).toBe(false);
	});
});
