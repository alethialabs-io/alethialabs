// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { ThresholdAssessment } from "@repo/legal/thresholds";
import Link from "next/link";
import { turnoverReport } from "@/lib/turnover";

/** The thresholds at `warn` or `stop`, by name. */
function flagged(named: readonly [string, ThresholdAssessment][]): string[] {
	return named.filter(([, a]) => a.verdict !== "ok").map(([name, a]) => `${name} (${a.verdict})`);
}

/**
 * A one-line notice on the staff home page when any tax threshold is at `warn` or `stop`, linking to
 * `/turnover`. Renders nothing while every threshold is `ok`, and nothing when the read fails: the
 * home page is the case queue and must not break on a turnover query. The operator alert is the
 * channel that must not be missed; this is a reminder beside it.
 */
export async function TurnoverNotice() {
	let names: string[];
	try {
		const { assessments } = await turnoverReport();
		names = flagged([
			[`Bulgaria ${assessments.year}`, assessments.bg],
			[`EU cross-border ${assessments.year}`, assessments.eu],
			...assessments.usStates.map((s): [string, ThresholdAssessment] => [`US ${s.state}`, s.assessment]),
		]);
	} catch (err) {
		console.error("[admin] turnover notice read failed", err);
		return null;
	}
	if (names.length === 0) return null;
	return (
		<div className="mb-4 rounded-md border border-border px-4 py-3 text-sm">
			Tax thresholds need attention: {names.join(", ")}.{" "}
			<Link href="/turnover" className="underline underline-offset-4">
				Open turnover
			</Link>
		</div>
	);
}
