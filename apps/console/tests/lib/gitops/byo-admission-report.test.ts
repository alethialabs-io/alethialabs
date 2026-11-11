// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6541 — the server-side half of the consent rule: turning refusal ON is refused over an incomplete
// report for every request, not only the drawer's, and keeping or turning OFF never is. The same pure
// rule the drawer applies; it has no server imports, so the drawer can bundle it.

import { describe, expect, it } from "vitest";
import {
	BYO_ADMISSION_INCOMPLETE_REPORT,
	byoAdmissionChangeRefusal,
} from "@/lib/gitops/byo-admission-report";
import type { ByoAdmissionNamespaceReport } from "@/types/jsonb.types";

const complete: ByoAdmissionNamespaceReport[] = [
	{
		namespace: "byo-a",
		charts: ["a"],
		mode: "warn",
		reason: "chart-history",
		checks: ["Service", "Ingress", "Secret", "PodSecurity"].map((kind) => ({ kind, state: "checked" as const })),
	},
];
const incomplete: ByoAdmissionNamespaceReport[] = [{ ...complete[0], checks: complete[0].checks?.slice(0, 3) }];

describe("byoAdmissionChangeRefusal", () => {
	it("refuses turning refusal on over an incomplete or missing report", () => {
		expect(byoAdmissionChangeRefusal(false, true, incomplete)).toBe(BYO_ADMISSION_INCOMPLETE_REPORT);
		expect(byoAdmissionChangeRefusal(false, true, [])).toBe(BYO_ADMISSION_INCOMPLETE_REPORT);
		expect(byoAdmissionChangeRefusal(false, true, complete)).toBeNull();
	});

	it("never refuses keeping it on, or turning it off", () => {
		expect(byoAdmissionChangeRefusal(true, true, [])).toBeNull();
		expect(byoAdmissionChangeRefusal(true, false, [])).toBeNull();
		expect(byoAdmissionChangeRefusal(false, false, [])).toBeNull();
	});
});
