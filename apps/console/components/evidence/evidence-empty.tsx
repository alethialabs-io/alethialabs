// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The two distinct page-level empty states. An org with zero environments gets
// onboarding (evidence appears once something is provisioned); an over-filtered
// view gets a one-click way back. Never the same string for both.

import Link from "next/link";
import { EvIcon } from "./evidence-status";

/** Shared centered frame for a page-level state. */
function StateFrame({ children }: { children: React.ReactNode }) {
	return (
		<div className="rounded-lg border bg-surface px-8 py-14 text-center shadow-sm">
			{children}
		</div>
	);
}

/** Zero environments in the org (also personal scope) — onboarding, not "no match". */
export function EvidenceOnboarding({ org }: { org: string }) {
	return (
		<StateFrame>
			<EvIcon
				name="shield-question"
				size={22}
				className="mx-auto mb-3 text-text-tertiary"
			/>
			<h3 className="font-display text-[15px] font-semibold text-text-primary">
				No environments yet
			</h3>
			<p className="mx-auto mt-1.5 max-w-[46ch] text-[12.5px] leading-relaxed text-text-secondary">
				Evidence appears once a project provisions its first environment. Create
				a project to start proving your infrastructure.
			</p>
			<Link
				href={`/${org}/~/new`}
				className="mt-5 inline-flex h-8 items-center rounded-sm border border-ink bg-ink px-3.5 text-[12.5px] font-medium text-ink-foreground transition-colors hover:bg-ink-hover"
			>
				Create a project
			</Link>
		</StateFrame>
	);
}

/** Filters are active and exclude everything — offer the way back. */
export function EvidenceNoMatch({ onClear }: { onClear: () => void }) {
	return (
		<StateFrame>
			<EvIcon
				name="search"
				size={22}
				className="mx-auto mb-3 text-text-tertiary"
			/>
			<h3 className="font-display text-[15px] font-semibold text-text-primary">
				No environments match these filters
			</h3>
			<p className="mx-auto mt-1.5 max-w-[46ch] text-[12.5px] leading-relaxed text-text-secondary">
				Every environment is excluded by the current search, cloud, stage, or
				status selection.
			</p>
			<button
				type="button"
				onClick={onClear}
				className="mt-5 inline-flex h-8 items-center rounded-sm border border-border-strong px-3.5 text-[12.5px] text-text-primary transition-colors hover:bg-surface-muted"
			>
				Clear filters
			</button>
		</StateFrame>
	);
}
