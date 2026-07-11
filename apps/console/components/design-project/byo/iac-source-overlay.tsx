"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The canvas takeover shown when an environment has a bring-your-own IaC source attached. In v1
// replace mode the module — not the component graph — is the source of truth, so the component
// nodes underneath are inert: this overlay dims them, states that plainly in a banner, and centers
// the read-only IacNode as the single thing to act on. It reads the attached source from
// IacSourceCanvasContext; renders nothing when there is no (enabled) source, letting the normal
// component canvas show through.

import { Info } from "lucide-react";
import { IacNode } from "@/components/design-project/byo/iac-node";
import { useIacSourceCanvas } from "@/components/design-project/byo/iac-source-canvas-context";

/** Full-canvas overlay: banner + centered external-IaC card, or null when no source is attached. */
export function IacSourceOverlay() {
	const ctx = useIacSourceCanvas();
	const source = ctx?.source ?? null;
	// Only take over the canvas for an ENABLED source — a disabled row falls back to the template.
	if (!source || !source.enabled) return null;

	return (
		<div className="absolute inset-0 z-20 flex flex-col bg-background/70 backdrop-blur-[1px]">
			{/* Banner — why the components below are inert. */}
			<div className="m-3 flex items-start gap-2.5 rounded-md border border-border bg-card px-3.5 py-2.5 text-card-foreground shadow-sm">
				<Info className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
				<div className="flex flex-col gap-0.5">
					<span className="text-[13px] font-medium text-foreground">
						This environment is provisioned from an external IaC source
					</span>
					<span className="text-[11.5px] leading-relaxed text-muted-foreground">
						Alethia plans, verifies, and applies the attached OpenTofu module in place of the built-in
						template. The component design below is not applied — detach the source to return to the
						template model.
					</span>
				</div>
			</div>

			{/* Centered read-only source card. */}
			<div className="flex flex-1 items-center justify-center px-3 pb-6">
				<IacNode source={source} />
			</div>
		</div>
	);
}
