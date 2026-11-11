// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Whether a BYO admission report is complete (#6541) — the one rule both the environment's
// admission drawer (a client component) and setByoAdmissionEnforce (the server, whatever sends the
// request) apply before refusal may be turned on. It has NO server imports on purpose: the drawer is
// bundled for the browser, and importing this rule from lib/gitops/deploy-status.ts pulled the
// database client into that bundle.

import type { ByoAdmissionNamespaceReport } from "@/types/jsonb.types";

/** The checks a complete BYO namespace report carries: every object kind, and Pod Security. */
export const BYO_ADMISSION_CHECK_KINDS = ["Service", "Ingress", "Secret", "PodSecurity"] as const;

/**
 * Whether a BYO admission report is COMPLETE: it exists, and every namespace whose charts were
 * deployed has every kind checked (Pod Security `enforced` counts). A namespace with no `checks` —
 * from a runner that predates them — is NOT complete: an absent check is not a clean one. Refused
 * namespaces were not deployed and are not checked.
 */
export function byoAdmissionReportComplete(report: readonly ByoAdmissionNamespaceReport[]): boolean {
	if (report.length === 0) return false;
	return report.every((ns) => {
		if (ns.mode === "refused") return true;
		return BYO_ADMISSION_CHECK_KINDS.every((kind) =>
			(ns.checks ?? []).some((c) => c.kind === kind && c.state !== "failed"),
		);
	});
}

/** Why turning refusal on is refused while the latest deploy's report is not complete. */
export const BYO_ADMISSION_INCOMPLETE_REPORT =
	"BYO admission refusal can be turned on only over a complete report from the latest deploy. Deploy this environment, check its report, then turn refusal on.";

/**
 * Why changing the setting from `current` to `wanted` must be refused, or null when it may go ahead.
 * Turning refusal ON needs a complete `report` — the same rule the drawer applies, here so that it
 * also holds for a request that does not come from the drawer. Keeping the setting, and turning
 * it OFF, are never refused: the off switch is the recovery path.
 */
export function byoAdmissionChangeRefusal(
	current: boolean,
	wanted: boolean,
	report: readonly ByoAdmissionNamespaceReport[],
): string | null {
	if (current || !wanted) return null;
	return byoAdmissionReportComplete(report) ? null : BYO_ADMISSION_INCOMPLETE_REPORT;
}
