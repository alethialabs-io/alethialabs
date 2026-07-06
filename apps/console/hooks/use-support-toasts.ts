"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { useEffect, useRef } from "react";
import { useParams, useRouter } from "next/navigation";
import { toast } from "sonner";
import { useSupportCasesQuery } from "@/lib/query/use-support-cases-query";
import { formatCaseNumber } from "@/components/support/cases/case-list-item";
import type { CaseListItem } from "@/lib/queries/support";

/**
 * The single support-reply toast driver. Mount it exactly once (via `<SupportToaster />` in the
 * app shell) — it owns ONLY the toast side-effect, decoupled from the notifications bell. It is
 * polling-driven (mirrors `use-job-toasts.ts`): on every settle of the shared support-cases
 * query it compares each case's `last_message_at` against the last value it observed and, when a
 * case advanced with a NON-customer author (`staff` / `ai` / `system` reply to the user), emits a
 * sonner toast.
 *
 * Cases present in the first settled snapshot seed the baseline and never toast — toasts are for
 * replies that arrive during THIS session; history lives on the "My cases" page and the bell. The
 * toast id is keyed by case id + timestamp, so a re-emit of the same reply on the next poll
 * updates the existing toast instead of stacking (the dedup mechanism).
 */
export function useSupportToasts(): void {
	const { data: cases } = useSupportCasesQuery();
	const router = useRouter();
	const { org } = useParams<{ org: string }>();

	// caseId → last `last_message_at` we've observed (ISO). Seeded on the first settle.
	const seenRef = useRef<Map<string, string>>(new Map());
	const seededRef = useRef(false);
	// Keep the live org in a ref so a "View case" closure created on one page still navigates
	// correctly after the user moves to another (the shell, and this hook, stay mounted).
	const orgRef = useRef(org);
	useEffect(() => {
		orgRef.current = org;
	}, [org]);

	useEffect(() => {
		// `undefined` = query not settled yet; wait for the first real fetch (including `[]`).
		if (cases === undefined) return;

		// Seed the baseline from the first settled snapshot (even an empty one) and emit nothing.
		if (!seededRef.current) {
			for (const c of cases) {
				seenRef.current.set(c.id, new Date(c.last_message_at).toISOString());
			}
			seededRef.current = true;
			return;
		}

		for (const c of cases) {
			const ts = new Date(c.last_message_at).toISOString();
			const prev = seenRef.current.get(c.id);
			// New case or an advanced timestamp counts as new activity.
			const advanced = prev === undefined || new Date(ts) > new Date(prev);
			if (!advanced) continue;
			seenRef.current.set(c.id, ts);
			// Only staff / ai / system replies are worth a toast — not the user's own message.
			if (c.last_author_type === "customer") continue;
			emit(c, ts);
		}

		/** Renders the toast for a fresh non-customer reply on a case. */
		function emit(c: CaseListItem, ts: string): void {
			const ref = formatCaseNumber(c.case_number);
			toast(`New reply on ${ref}`, {
				id: `support-${c.id}-${ts}`,
				description: c.subject,
				duration: 8000,
				action: {
					label: "View case",
					onClick: () =>
						router.push(`/${orgRef.current}/~/support/cases/${c.id}`),
				},
			});
		}
	}, [cases, router]);
}
