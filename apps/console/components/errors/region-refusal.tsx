// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// No "use client": presentational, rendered by server routes (a gate decided before any read) and
// by client regions (a live refusal from the read router) alike.

import { Lock } from "lucide-react";

import { EmptyState } from "@repo/ui/empty";
import { cn } from "@repo/ui/utils";
import type { ReadRefusal } from "@/lib/rpc/refusal";

/** The two lines a refusal is told in. */
export interface RefusalCopy {
	title: string;
	description: string;
}

/**
 * The ONE wording of each refusal, in terms of `subject`: what was asked for, as it reads after
 * "access to" ("clusters", "the activity log", "these settings"). Without a subject the lines say
 * "this".
 */
export function refusalCopy(refusal: ReadRefusal, subject?: string): RefusalCopy {
	const what = subject ?? "this";
	switch (refusal) {
		case "forbidden":
			return {
				title: `You don't have access to ${what}`,
				description: "Your role in this organization doesn't include it. Ask an owner or admin for access.",
			};
		case "not-found":
			return {
				title: "Not found",
				description: "This no longer exists, or it isn't in this organization.",
			};
		case "plan":
			return {
				title: "Not on this plan",
				description: `Your plan doesn't include ${what}.`,
			};
		// Shown behind the session-ended dialog (`components/shell/session-ended.tsx`), which is what
		// offers the way back in.
		case "sign-in":
			return {
				title: "Your session has ended",
				description: `Sign in again to see ${what}.`,
			};
	}
}

interface RegionRefusalProps {
	/** Which expected refusal this is (`readRefusalOf` in `lib/rpc/refusal.ts`). */
	refusal: ReadRefusal;
	/** What was asked for, as it reads after "access to": "clusters", "the activity log". */
	subject?: string;
	/**
	 * Replaces the title. For a region whose rule is not the viewer's role in the organization and
	 * so cannot be said in the shared words; everything else passes `subject`.
	 */
	title?: string;
	/** Replaces the description, under the same condition as `title`. */
	description?: string;
	/**
	 * One line of text and no frame: for a refusal inside a narrow column or a card that already has
	 * a heading, where the full render would be larger than the thing it replaces.
	 */
	compact?: boolean;
	className?: string;
}

/**
 * The refused render of ONE data region or one page: the read router answered with an expected
 * refusal, or the route decided the gate itself before reading.
 *
 * A refusal is not a failure and not an empty list, and must not look like either (RUBRIC B4):
 * - no retry, because the same question gets the same answer;
 * - a lock, where `RegionError` has an alert mark and an empty state has the thing's own icon;
 * - `data-state="refused"` and `data-refusal`, where `RegionError` has `data-state="error"`, for a
 *   reader and a test.
 *
 * It is not announced (`role="alert"`): nothing went wrong, and it is the page's settled content.
 * The full render keeps `EmptyState`'s own `data-slot="empty"`, which is what the e2e audits read
 * a deliberate non-data render by; `data-state` is what tells it apart from a real empty list.
 *
 * THE RULE, with `RegionError`'s: a read that was REFUSED renders this; a read that FAILED renders
 * `RegionError`. Tell them apart with `readRefusalOf(error)`, never by message.
 *
 * @example
 * const refusal = readRefusalOf(query.error);
 * if (refusal) return <RegionRefusal refusal={refusal} subject="clusters" />;
 */
export function RegionRefusal({
	refusal,
	subject,
	title,
	description,
	compact = false,
	className,
}: RegionRefusalProps) {
	const copy = refusalCopy(refusal, subject);
	if (compact) {
		return (
			<p
				data-state="refused"
				data-refusal={refusal}
				className={cn("text-ui-sm text-muted-foreground", className)}
			>
				{title ?? copy.title}.
			</p>
		);
	}
	return (
		<EmptyState
			data-state="refused"
			data-refusal={refusal}
			className={cn("border border-dashed border-border p-6 md:p-6", className)}
			icon={<Lock size={18} aria-hidden />}
			title={title ?? copy.title}
			description={description ?? copy.description}
		/>
	);
}
