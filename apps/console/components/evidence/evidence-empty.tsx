// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The page-level states that are not rows. An org with zero environments gets
// onboarding (evidence appears once something is provisioned); a refused read says so.
// An over-filtered view is the shared `FilterEmpty` (@repo/ui/filter-bar), rendered by the
// client in this file's card. Never the same string twice.
//
// These render through the shared `EmptyState` from `@repo/ui/empty` rather than the
// local `StateFrame` they used to share, so the icon tile, the type scale and the
// action slot match every other empty state in the console. The card treatment (the
// bordered, raised surface the posture table would have occupied) is the only thing
// still supplied here, via `className`.

import Link from "next/link";
import { Button } from "@repo/ui/button";
import { EmptyState } from "@repo/ui/empty";
import { RegionRefusal } from "@/components/errors/region-refusal";
import { EvIcon } from "./evidence-status";

/**
 * The card the posture table would have occupied — an empty state has to hold the same space. The
 * client hands it to the filtered `FilterEmpty` too, so "no match" holds the same space.
 */
export const EVIDENCE_EMPTY_CARD = "border border-solid bg-surface p-12 shadow-sm md:p-14";
const CARD = EVIDENCE_EMPTY_CARD;

/** Zero environments the reader can see — onboarding, not "no match". */
export function EvidenceOnboarding({ org }: { org: string }) {
	return (
		<EmptyState
			className={CARD}
			icon={<EvIcon name="shield-question" size={22} />}
			title="No environments yet"
			description="Evidence appears once a project provisions its first environment. Create a project to start proving your infrastructure."
			action={
				<Button
					size="sm"
					nativeButton={false}
					render={<Link href={`/${org}/~/new`} />}
				>
					Create a project
				</Button>
			}
		/>
	);
}

/**
 * The read was REFUSED (a typed FORBIDDEN from the read router) — not empty, and not a failure.
 * A refusal answers the same on a retry, so there is no retry to offer; the way forward is access.
 * The console's one refused render, in the card the posture table would have occupied.
 */
export function EvidenceForbidden() {
	return (
		<RegionRefusal refusal="forbidden" subject="evidence" className={CARD} />
	);
}
