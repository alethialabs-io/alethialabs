// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The recorded-waivers panel — the org-wide log of authorized, time-boxed control
// overrides that let a fail-closed apply proceed deliberately. Read-only; produced when a
// DEPLOY carries a jobs.verify_override.

import Link from "next/link";
import { cn } from "@repo/ui/utils";
import type { EvidenceWaiver } from "@/lib/queries/evidence";
import { relTime } from "./evidence-derive";
import { EvIcon } from "./evidence-status";

/** The recorded-waivers panel below the posture table. */
export function EvidenceWaivers({
	org,
	waivers,
}: {
	org: string;
	waivers: EvidenceWaiver[];
}) {
	const active = waivers.filter((w) => w.active).length;
	return (
		<div className="overflow-hidden rounded-lg border bg-surface shadow-sm">
			<div className="flex items-center gap-2.5 border-b px-4 py-3.5">
				<EvIcon name="scroll" size={15} className="text-text-secondary" />
				<span className="font-display text-[14px] font-semibold text-text-primary">
					Recorded waivers
				</span>
				<span className="rounded-full border px-2 py-px font-mono text-[10px] text-text-tertiary">
					{active} active
				</span>
				<span className="flex-1" />
				{waivers.length >= 100 && (
					<span className="font-mono text-[10px] text-text-disabled">
						Showing the 100 most recent
					</span>
				)}
			</div>
			{waivers.length === 0 ? (
				<div className="px-4 py-10 text-center font-mono text-[12px] text-text-disabled">
					No waivers — every apply cleared the gate without an override.
				</div>
			) : (
				waivers.map((w) => (
					<div
						key={w.jobId}
						className="grid grid-cols-[minmax(180px,1fr)_minmax(220px,1.4fr)_150px_108px] items-start gap-4 border-b border-border-faint px-4 py-3.5 last:border-0"
					>
						<div className="flex min-w-0 flex-col gap-1.5">
							<div className="text-[12.5px] font-medium text-text-primary">
								{w.projectName ?? "—"}
								{w.environmentName ? (
									<span className="text-text-tertiary"> · {w.environmentName}</span>
								) : null}
							</div>
							<div className="flex flex-wrap gap-1">
								{w.controls.map((c) => (
									<span
										key={c}
										className="rounded-xs border bg-surface-sunken px-1.5 py-0.5 font-mono text-[10px] text-text-secondary"
									>
										{c}
									</span>
								))}
							</div>
						</div>
						<div className="text-[12px] leading-relaxed text-text-secondary">
							{w.reason}
						</div>
						<div className="flex flex-col gap-0.5 font-mono text-[10.5px] text-text-tertiary">
							<span className="text-text-secondary">{w.by}</span>
							<span>{relTime(w.createdAt)}</span>
							<Link
								href={`/${org}/~/jobs/${w.jobId}`}
								className="w-fit underline-offset-2 hover:text-text-primary hover:underline"
							>
								View job
							</Link>
						</div>
						<div className="flex flex-col items-start gap-1">
							<span
								className={cn(
									"inline-flex items-center gap-1.5 font-mono text-[9.5px] uppercase tracking-wide",
									w.active ? "text-text-secondary" : "text-text-disabled",
								)}
							>
								<span
									className={cn(
										"size-[7px] shrink-0 rounded-full",
										w.active ? "bg-text-secondary" : "bg-border-strong",
									)}
								/>
								{w.active ? "Active" : "Expired"}
							</span>
							<span className="font-mono text-[10px] text-text-disabled">
								{w.expiry ? `Expires ${relTime(w.expiry)}` : "No expiry"}
							</span>
						</div>
					</div>
				))
			)}
		</div>
	);
}
