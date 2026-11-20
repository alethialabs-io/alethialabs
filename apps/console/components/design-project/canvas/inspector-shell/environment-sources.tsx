"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { useMemo } from "react";
import { EmptyState } from "@repo/ui/empty";
import { SectionHeading } from "@repo/ui/section-heading";
import { IacNode } from "@/components/design-project/byo/iac-node";
import { useIacSourceCanvas } from "@/components/design-project/byo/iac-source-canvas-context";
import { useBoard } from "@/lib/canvas/store/canvas-store-provider";
import { useCanvasStore } from "@/lib/stores/use-canvas-store";
import { IacScanCard } from "../cards/iac-scan-card";
import { InspectorEmbed } from "./inspector-frame";

/**
 * The environment's Sources view: the infrastructure module that governs it, with its safety
 * scan, and the charts attached to it. Each chart row opens that chart.
 */
export function EnvironmentSources() {
	const board = useBoard();
	const iac = useIacSourceCanvas();
	const nodes = useCanvasStore((s) => s.nodes);
	const charts = useMemo(() => nodes.filter((n) => n.data.kind === "chart"), [nodes]);

	return (
		<div className="space-y-6">
			<section className="space-y-3">
				<SectionHeading
					level={3}
					title="Infrastructure module"
					description="A module of your own that defines this environment's cluster and network in place of the built-in template."
				/>
				{iac?.source ? <IacNode source={iac.source} /> : null}
				<InspectorEmbed>
					<IacScanCard />
				</InspectorEmbed>
			</section>
			<section className="space-y-3">
				<SectionHeading level={3} title="Charts" count={charts.length} />
				{charts.length === 0 ? (
					<EmptyState
						className="px-0 py-4 md:px-0 md:py-4"
						title="No charts are attached"
						description="Attach a Helm chart of your own and it is listed here with its safety scan."
					/>
				) : (
					<ul className="border-t border-border">
						{charts.map((node) =>
							node.data.kind === "chart" ? (
								<li key={node.id} className="border-b border-border">
									<button
										type="button"
										onClick={() =>
											board.view.getState().setSubject({ kind: "node", id: node.id }, "status")
										}
										className="flex w-full items-center justify-between gap-3 px-1 py-2.5 text-left transition-colors hover:bg-muted focus-visible:outline-1 focus-visible:outline-ring"
									>
										<span className="min-w-0 truncate font-mono text-xs">
											{node.data.config.id}
										</span>
										<span className="vx-eyebrow shrink-0 text-ui-3xs">
											{node.data.config.scanStatus ?? "unscanned"}
										</span>
									</button>
								</li>
							) : null,
						)}
					</ul>
				)}
			</section>
		</div>
	);
}
