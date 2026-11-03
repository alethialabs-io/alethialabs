"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { ArrowRight, Loader2 } from "lucide-react";
import { useId } from "react";

import { cn } from "@repo/ui/utils";

import {
	NEW_PILL_CLASS,
	SCRATCH_CARD_CLASS,
	SCRATCH_DESCRIPTION_CLASS,
	SCRATCH_GRID_CLASS,
	SCRATCH_TITLE_ROW_CLASS,
	scratchCards,
} from "./chooser-parts";

/** The four ways to start a project from scratch (no repo import). */
export type ScratchKind = "template" | "byo-helm" | "byo-iac" | "blank";

interface StartFromScratchCardsProps {
	/** Gate the BYO Helm card (ALETHIA_BYO_HELM_ENABLED). */
	byoHelmEnabled: boolean;
	/** Gate the BYO IaC card (ALETHIA_BYO_IAC_ENABLED). */
	byoIacEnabled: boolean;
	/** Disable every card while a create is in flight. */
	busy?: boolean;
	/** Which card is mid-create (renders a spinner in its icon slot). */
	pending?: ScratchKind | null;
	/** The host wires each kind to a create-and-navigate handler (it owns name + cloud + placement). */
	onSelect: (kind: ScratchKind) => void;
}

/**
 * The start-from-scratch card grid — the right column of the `~/new` front door. A presentational
 * 2×2 grid of the four scratch on-ramps (Template · BYO Helm · BYO IaC · Blank); the host form owns
 * the create-and-navigate logic per kind (it holds the project name, selected cloud and placement)
 * and passes it as `onSelect`. Feature-gated cards drop out when their flag is off.
 *
 * - **Template** → a standard cluster the user configures (cloud + template) → canvas.
 * - **BYO Helm** → empty project → `?attachChart=1` (the ByoChartDialog on the canvas).
 * - **BYO IaC** → empty project → `?attachIac=1` (the ByoIacDialog on the canvas).
 * - **Blank** → an empty project → the canvas, components added by hand.
 */
export function StartFromScratchCards({
	byoHelmEnabled,
	byoIacEnabled,
	busy,
	pending,
	onSelect,
}: StartFromScratchCardsProps) {
	// One render-stable prefix for the title/description ids the tiles point their names and
	// descriptions at. `useId` rather than a bare `${card.kind}-title`, because these ids are
	// document-global and `template`/`blank` are the kind of words another surface will pick.
	const uid = useId();
	const cards = scratchCards({ byoHelmEnabled, byoIacEnabled });

	return (
		<div className={SCRATCH_GRID_CLASS}>
			{cards.map((card) => {
				const Icon = card.icon;
				const isPending = pending === card.kind;
				return (
					<button
						key={card.kind}
						type="button"
						// The tile's accessible name is its TITLE, not the whole card (#4269). Without
						// this it was the title, the two-line description and — on the BYO cards — the
						// word "New" run together, so "Start from a template" and "Start from scratch"
						// (the column heading directly above) were the only two ways to tell four
						// controls apart, and the name changed whenever the marketing copy did.
						// WCAG 2.5.3 still holds: the visible title is the whole of the name here, so
						// a voice-control user saying what they can read still hits the control.
						//
						// REFERENCED, NOT COPIED, and that is the load-bearing part. `role="button"`
						// is CHILDREN-PRESENTATIONAL in ARIA: a button's descendant content reaches
						// assistive tech only through name-from-content, so an `aria-label` here does
						// not merely REPLACE the name — it suppresses name-from-content and takes the
						// two-line description out of the accessibility tree with it. A screen-reader
						// user heard "Start from a template, button" and nothing about what the tile
						// does. Pointing the name at the title node and the description at the
						// description node keeps the same accessible name and gives the description
						// back as a description.
						aria-labelledby={`${uid}-${card.kind}-title`}
						aria-describedby={`${uid}-${card.kind}-desc`}
						onClick={() => onSelect(card.kind)}
						disabled={busy}
						className={cn("group transition-colors hover:border-ring disabled:opacity-60", SCRATCH_CARD_CLASS)}
					>
						<span className="grid size-9 shrink-0 place-items-center rounded-md border border-border text-muted-foreground">
							{isPending ? (
								<Loader2 className="size-4 animate-spin" />
							) : (
								<Icon className="size-4" />
							)}
						</span>
						<span className="min-w-0 flex-1">
							<span className={cn(SCRATCH_TITLE_ROW_CLASS, "text-foreground")}>
								{/* The id is on the TITLE ALONE, not on this row: the row also holds the
								    "New" pill, and naming the tile from it would put "New" back into
								    the accessible name — the copy-dependent name #4269 removed. */}
								<span id={`${uid}-${card.kind}-title`}>{card.title}</span>
								{card.isNew && (
									<span className={cn(NEW_PILL_CLASS, "border-border text-muted-foreground")}>
										New
									</span>
								)}
							</span>
							<span
								id={`${uid}-${card.kind}-desc`}
								className={cn(SCRATCH_DESCRIPTION_CLASS, "text-muted-foreground")}
							>
								{card.description}
							</span>
						</span>
						<ArrowRight
							className={cn(
								"size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5",
							)}
						/>
					</button>
				);
			})}
		</div>
	);
}
