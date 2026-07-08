// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The triage strip — clickable posture counters split into "needs attention" (destructive)
// and "coverage gaps" (unknown). Clicking a counter sets the active triage filter over the
// table; clicking the active one clears it back to "all".

import { cn } from "@repo/ui/utils";
import type { TriageCluster, TriageKey } from "./evidence-derive";
import { TONE_TEXT } from "./evidence-status";

/** The clickable triage / posture strip. */
export function EvidenceTriage({
	clusters,
	active,
	onSelect,
}: {
	clusters: TriageCluster[];
	active: TriageKey;
	onSelect: (key: TriageKey) => void;
}) {
	return (
		<div className="flex flex-wrap overflow-hidden rounded-lg border bg-surface shadow-sm">
			{clusters.map((cluster, i) => (
				<div
					key={cluster.key}
					className={cn(
						"min-w-[250px] flex-1 px-4 py-3.5",
						i > 0 && "border-l",
					)}
				>
					<div className="mb-2.5 font-mono text-[9px] uppercase tracking-[0.16em] text-text-disabled">
						{cluster.label}
					</div>
					<div className="flex gap-1.5">
						{cluster.items.map((item) => {
							const isActive = active === item.key;
							return (
								<button
									key={item.key}
									type="button"
									title={`Filter to ${item.label.toLowerCase()}`}
									onClick={() => onSelect(isActive ? "all" : item.key)}
									className={cn(
										"flex min-w-0 flex-1 flex-col gap-1.5 rounded-sm border border-transparent px-2.5 py-2 text-left transition-colors hover:bg-surface-muted",
										isActive && "border-border-strong bg-surface-muted",
									)}
								>
									<span className="flex items-baseline gap-1.5">
										<span
											className={cn(
												"font-display text-xl font-semibold leading-none tracking-tight tabular-nums",
												item.value > 0 ? TONE_TEXT[item.tone] : "text-text-disabled",
											)}
										>
											{item.value}
										</span>
									</span>
									<span className="truncate font-mono text-[9.5px] uppercase tracking-wide text-text-tertiary">
										{item.label}
									</span>
								</button>
							);
						})}
					</div>
				</div>
			))}
		</div>
	);
}
