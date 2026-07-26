"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The environment's compatibility alert (#1221) — the config-time half of the compat surfaces, next
// to the Kubernetes version that causes the problem.
//
// TWO HONESTY RULES SHAPE THIS, and both are the reason it looks smaller than a "report":
//
// 1. IT NEVER SAYS EVERYTHING IS FINE. The subject assembled in the browser is a SUBSET of the one
//    the config-time resolver builds server-side (`projects.ts` also feeds in Hetzner in-cluster
//    data services and BYO charts). And there is no stored verdict to read instead — the report
//    rides `jobs.config_snapshot`, nothing queries it, and EnvironmentStatus has no compat field.
//    So a green "all compatible" banner would be a claim this component cannot back. It reports
//    problems and is otherwise silent.
//
// 2. IT ONLY OPENS FOR A REAL FAILURE. `not_evaluable` is the steady state, not an exception —
//    9 of the 19 catalogued add-ons have no recorded window — so a banner that counted them would
//    be permanently on, and a banner that is always on is furniture. The unknowns ride along as a
//    footnote INSIDE a real warning, and stay visible per-add-on where they are actionable (the
//    card chip and palette badge from #1222).
//
// Advisory, always. The blocking gate is COMPAT-001 at apply time (#1215).

import { useMemo } from "react";
import { TriangleAlert } from "lucide-react";
import { Alert, AlertDescription } from "@repo/ui/alert";
import { evaluate } from "@/lib/compat";
import type { CloudProviderSlug } from "@/lib/cloud-providers";

export function CompatAlert({
	provider,
	k8sVersion,
	addonIds,
}: {
	provider: CloudProviderSlug | null;
	k8sVersion: string | undefined;
	/** Marketplace add-ons enabled on this environment. A subset — see rule 1 above. */
	addonIds: string[];
}) {
	const report = useMemo(
		() =>
			evaluate({
				providers: provider ? [provider] : [],
				k8sVersion,
				addons: addonIds.map((id) => ({ id })),
			}),
		[provider, k8sVersion, addonIds],
	);

	const fails = report.controls.filter((c) => c.status === "fail");
	if (fails.length === 0) return null;

	const unknown = report.controls.filter((c) => c.status === "not_evaluable").length;

	return (
		<Alert variant="default" className="border-border bg-muted">
			<TriangleAlert className="h-4 w-4" />
			<AlertDescription className="space-y-1.5 text-xs">
				<p className="font-medium text-foreground">
					{fails.length === 1
						? "One thing won't work on this Kubernetes version"
						: `${fails.length} things won't work on this Kubernetes version`}
				</p>
				<ul className="space-y-1">
					{fails.map((c) => (
						<li key={c.id} className="text-muted-foreground">
							{/* The engine already phrases this as "requires Kubernetes 1.25+, cluster is 1.24".
							    Rendering its own message keeps one wording across the console, the plan
							    artifact and the runner's apply gate. */}
							{c.findings?.[0]?.message ?? c.title}
						</li>
					))}
				</ul>
				{unknown > 0 && (
					<p className="text-muted-foreground">
						{unknown === 1
							? "1 other has no recorded compatibility window and couldn't be checked."
							: `${unknown} others have no recorded compatibility window and couldn't be checked.`}
					</p>
				)}
				<p className="text-muted-foreground">
					Checked against your marketplace add-ons. Deploying is still allowed — the apply
					gate is the authority.
				</p>
			</AlertDescription>
		</Alert>
	);
}
