"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The drill-down drawer for a value — "which resources carry this value", broken down by
// resource kind (e.g. 12 projects · 8 clusters · 4 runners). Read-only; loads lazily when
// opened. Individual resource names aren't resolved (they live across ~14 tables) — the
// per-kind counts are the honest, cheap answer.

import { Sheet, SheetContent } from "@repo/ui/sheet";
import { Skeleton } from "@repo/ui/skeleton";
import { useQuery } from "@tanstack/react-query";
import { Boxes, X } from "lucide-react";
import type { ValueDTO } from "@/app/server/actions/classification/dimensions";
import { getValueResourceBreakdown } from "@/app/server/actions/classification/assignments";
import { kindLabel } from "./resource-kind-labels";

/** The value drill-down drawer. Open when `value` is set. */
export function ValueDrillDrawer({
	value,
	dimensionLabel,
	onClose,
}: {
	value: ValueDTO | null;
	dimensionLabel: string;
	onClose: () => void;
}) {
	const { data, isPending } = useQuery({
		queryKey: ["classification", "value-breakdown", value?.id],
		queryFn: () => getValueResourceBreakdown(value?.id ?? ""),
		enabled: Boolean(value),
	});

	const total = (data ?? []).reduce((n, r) => n + r.count, 0);

	return (
		<Sheet open={Boolean(value)} onOpenChange={(o) => !o && onClose()}>
			<SheetContent
				side="right"
				showCloseButton={false}
				className="w-[400px] gap-0 border-border-strong bg-surface-raised p-0 sm:max-w-none"
			>
				{value && (
					<>
						<div className="sticky top-0 border-b bg-surface-raised px-5 pb-4 pt-[18px]">
							<div className="flex items-start justify-between gap-3">
								<div>
									<div className="mb-[7px] font-mono text-[9.5px] uppercase tracking-[0.14em] text-text-tertiary">
										{dimensionLabel} · value
									</div>
									<div className="flex items-center gap-2.5">
										<h3 className="m-0 font-display text-lg font-semibold tracking-tight">
											{value.label}
										</h3>
									</div>
									<div className="mt-1.5 text-[12px] text-text-secondary">
										{isPending
											? "Loading…"
											: total === 0
												? "No resources"
												: `${total} resource${total === 1 ? "" : "s"} across ${(data ?? []).length} kind${(data ?? []).length === 1 ? "" : "s"}`}
									</div>
								</div>
								<button
									type="button"
									onClick={onClose}
									aria-label="Close"
									className="grid size-[30px] shrink-0 place-items-center rounded-[2px] border border-border-strong bg-surface text-text-secondary transition-colors hover:bg-surface-muted hover:text-text-primary"
								>
									<X className="size-[15px]" />
								</button>
							</div>
						</div>

						<div className="flex-1 overflow-y-auto px-2.5 pb-5 pt-2">
							{isPending ? (
								<div className="space-y-2 p-2">
									<Skeleton className="h-11 w-full" />
									<Skeleton className="h-11 w-full" />
									<Skeleton className="h-11 w-full" />
								</div>
							) : total === 0 ? (
								<div className="px-4 py-9 text-center">
									<div className="mb-1.5 text-[13px] text-text-secondary">
										No resources use this value.
									</div>
									<div className="text-[11.5px] text-text-tertiary">
										Unused values are safe to delete or repurpose.
									</div>
								</div>
							) : (
								(data ?? []).map((r) => (
									<div
										key={r.resource_kind}
										className="flex items-center gap-3 rounded-[2px] px-2.5 py-2.5 transition-colors hover:bg-surface-muted"
									>
										<span className="grid size-7 shrink-0 place-items-center rounded-[3px] border bg-surface-sunken text-text-tertiary">
											<Boxes className="size-3.5" />
										</span>
										<div className="min-w-0 flex-1">
											<div className="text-[13px] font-medium text-text-primary">
												{kindLabel(r.resource_kind)}
											</div>
											<div className="font-mono text-[10.5px] text-text-tertiary">
												{r.resource_kind}
											</div>
										</div>
										<span className="font-mono text-[13px] text-text-secondary">
											{r.count}
										</span>
									</div>
								))
							)}
						</div>
					</>
				)}
			</SheetContent>
		</Sheet>
	);
}
