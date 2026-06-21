"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Plan-history timeline (Billing page). Derived honestly from what we know today
// (org created + current plan) — there's no billing event log yet, so this stays
// minimal rather than inventing history.

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { getPlanHistory, type PlanHistoryEntry } from "@/app/server/actions/billing";
import { Skeleton } from "@/components/ui/skeleton";
import styles from "./billing-design.module.css";

/** "1 Mar 2026" — compact, locale-stable date for the timeline. */
function formatDate(iso: string): string {
	return new Date(iso).toLocaleDateString(undefined, {
		day: "numeric",
		month: "short",
		year: "numeric",
	});
}

export function PlanHistoryTimeline() {
	const [entries, setEntries] = useState<PlanHistoryEntry[] | null>(null);

	useEffect(() => {
		getPlanHistory()
			.then(setEntries)
			.catch(() => toast.error("Couldn't load plan history."));
	}, []);

	return (
		<section className={styles.section}>
			<div className={styles.sectionHead}>
				<h2>Plan history</h2>
				<span className={styles.rule} />
			</div>
			<div className={`${styles.card} ${styles.timeline}`}>
				{!entries ? (
					<Skeleton className="h-20 w-full" />
				) : entries.length === 0 ? (
					<div className={styles.empty} style={{ padding: 0 }}>
						No plan history yet.
					</div>
				) : (
					<div className={styles.tl}>
						{entries.map((e) => (
							<div
								key={`${e.when}:${e.title}`}
								className={`${styles.tlItem} ${e.current ? styles.cur : ""}`}
							>
								<div className={styles.node} />
								<div className={styles.when}>{formatDate(e.when)}</div>
								<div className={styles.what}>{e.title}</div>
								<div className={styles.detail}>{e.detail}</div>
							</div>
						))}
					</div>
				)}
			</div>
		</section>
	);
}
