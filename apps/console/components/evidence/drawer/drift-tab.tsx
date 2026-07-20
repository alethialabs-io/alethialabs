// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The drawer's Drift tab: per-resource divergence (kind pill + tofu address + type),
// or the in-sync/never-scanned states. Purposeful empty state when no drift scan has
// ever recorded a posture for this environment.

import { cn } from "@repo/ui/utils";
import type { EvidenceEnvRow } from "../evidence-derive";
import { relTime } from "../evidence-derive";
import { EVIDENCE_HELP } from "../evidence-help";
import { kindTone, TONE_TEXT } from "../evidence-status";
import { TabEmpty } from "./tab-empty";

/** The Drift tab body. */
export function DriftTab({ row }: { row: EvidenceEnvRow }) {
	const drift = row.drift;
	if (!drift) {
		return (
			<TabEmpty
				icon="rotate"
				title="No drift scan recorded"
				description="Drift posture appears once a refresh-only plan runs against this environment and compares the cloud with the provisioned state."
				docsHref={EVIDENCE_HELP.drift.docsHref}
			/>
		);
	}

	return (
		<div className="flex flex-col gap-3">
			<div className="font-mono text-[11px] text-text-secondary">
				{drift.inSync
					? `In sync — no managed resource has drifted. Scanned ${relTime(drift.scannedAt)}.`
					: `${drift.drifted} resource${drift.drifted === 1 ? "" : "s"} diverged from the provisioned state. Scanned ${relTime(drift.scannedAt)}.`}
			</div>
			{drift.details.length > 0 && (
				<div className="flex flex-col overflow-hidden rounded-md border">
					{drift.details.map((d) => (
						<div
							key={d.address}
							className="flex items-center gap-3 border-b border-border-faint bg-surface px-3 py-2.5 last:border-0"
						>
							<span
								className={cn(
									"shrink-0 rounded-full border border-border-strong px-2 py-0.5 font-mono text-[8.5px] uppercase tracking-wide",
									TONE_TEXT[kindTone(d.kind)],
								)}
							>
								{d.kind}
							</span>
							<div className="min-w-0 flex-1">
								<div className="truncate font-mono text-[11.5px] text-text-primary">
									{d.address}
								</div>
								<div className="mt-0.5 font-mono text-[10px] text-text-tertiary">
									{d.type}
								</div>
							</div>
						</div>
					))}
				</div>
			)}
		</div>
	);
}
