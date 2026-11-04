// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The page-level states that are not rows. An org with zero environments gets
// onboarding (evidence appears once something is provisioned); an over-filtered
// view gets a one-click way back; a refused read says so. Never the same string twice.
//
// Both render through the shared `EmptyState` from `@repo/ui/empty` rather than the
// local `StateFrame` they used to share, so the icon tile, the type scale and the
// action slot match every other empty state in the console. The card treatment (the
// bordered, raised surface the posture table would have occupied) is the only thing
// still supplied here, via `className`.

import Link from "next/link";
import { Button } from "@repo/ui/button";
import { EmptyState } from "@repo/ui/empty";
import { EvIcon } from "./evidence-status";

/** The card the posture table would have occupied — an empty state has to hold the same space. */
const CARD = "border border-solid bg-surface p-12 shadow-sm md:p-14";

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

/** Filters are active and exclude everything — offer the way back. */
export function EvidenceNoMatch({ onClear }: { onClear: () => void }) {
	return (
		<EmptyState
			className={CARD}
			icon={<EvIcon name="search" size={22} />}
			title="No environments match these filters"
			description="Every environment is excluded by the current search, cloud, stage, or status selection."
			action={
				<Button variant="outline" size="sm" onClick={onClear}>
					Clear filters
				</Button>
			}
		/>
	);
}

/**
 * The read was REFUSED (a typed FORBIDDEN from the read router) — not empty, and not a failure.
 * A refusal answers the same on a retry, so there is no retry to offer; the way forward is access.
 */
export function EvidenceForbidden() {
	return (
		<EmptyState
			className={CARD}
			data-state="forbidden"
			icon={<EvIcon name="shield-alert" size={22} />}
			title="You can't view evidence here"
			description="Your role in this organization doesn't include its projects' evidence. Ask an owner or admin for access."
		/>
	);
}
