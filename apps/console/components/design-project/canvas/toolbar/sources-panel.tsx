"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { X } from "lucide-react";
import { Button } from "@repo/ui/button";
import type { IacSourceState } from "@/app/server/actions/byo-iac";
import { IacNode } from "@/components/design-project/byo/iac-node";
import { SourceReposCard, type SourceRepoRow } from "../../source-repos-card";

/** The id the toolbar's Sources tool points its `aria-controls` at. */
export const SOURCES_PANEL_ID = "canvas-sources-panel";

/**
 * Where this environment's design came from: the repositories that were scanned to infer it, and
 * the bring-your-own IaC module that governs it (repo · ref · the commit the scan pinned · the scan
 * verdict, with detach and rescan).
 *
 * It opens under the toolbar, from the toolbar's Sources tool, and closes from that tool, its own
 * close button or Escape. Both of its parts used to be cards pinned to a corner of the board: the
 * repositories over the zoom controls, the module's card over the minimap (#6832).
 *
 * It is a plain region in the page, not a popover, on purpose: the module's card opens its own
 * confirmation before a detach, and a surface that closes on an outside press would close under
 * that confirmation.
 */
export function SourcesPanel({
	repos,
	iacSource,
	onClose,
}: {
	repos: readonly SourceRepoRow[];
	/** The governing module, or null when the environment is designed on the board. */
	iacSource: IacSourceState | null;
	onClose: () => void;
}) {
	return (
		<section
			id={SOURCES_PANEL_ID}
			aria-label="Sources"
			className="pointer-events-auto w-80 max-w-full space-y-2 border border-border bg-card p-2 shadow-sm"
		>
			<div className="flex items-center justify-between">
				<span className="vx-eyebrow">Sources</span>
				<Button
					type="button"
					variant="ghost"
					size="icon-xs"
					aria-label="Close sources"
					onClick={onClose}
				>
					<X />
				</Button>
			</div>
			<SourceReposCard repos={repos} />
			{iacSource && <IacNode source={iacSource} />}
		</section>
	);
}
