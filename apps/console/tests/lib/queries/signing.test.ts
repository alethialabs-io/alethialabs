// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { resolveReceiptSignerPosture } from "@/lib/queries/signing";

type K = { provider: string; status: string; active: boolean };
const active = (provider: string): K => ({ provider, status: "active", active: true });
const pending = (provider: string): K => ({ provider, status: "pending_verification", active: false });

describe("resolveReceiptSignerPosture (honest surfacing #884)", () => {
	it("org_active when an active key matches the project's cloud", () => {
		expect(resolveReceiptSignerPosture([active("aws")], "aws").posture).toBe("org_active");
	});
	it("org_wrong_cloud when the active key is for a different cloud", () => {
		const r = resolveReceiptSignerPosture([active("gcp")], "aws");
		expect(r.posture).toBe("org_wrong_cloud");
		expect(r.reason).toMatch(/gcp/);
		expect(r.reason).toMatch(/aws/);
	});
	it("org_pending when a key is registered but not yet verified", () => {
		expect(resolveReceiptSignerPosture([pending("aws")], "aws").posture).toBe("org_pending");
	});
	it("platform when the org has no signing key", () => {
		expect(resolveReceiptSignerPosture([], "aws").posture).toBe("platform");
	});
	it("does NOT claim org_active for a pending key on the matching cloud (never over-states trust)", () => {
		expect(resolveReceiptSignerPosture([pending("aws")], "aws").posture).not.toBe("org_active");
	});
});
