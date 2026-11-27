// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { formatDate } from "@repo/format";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@repo/ui/table";
import Link from "next/link";
import type { PrivacyListRow } from "@/app/privacy/data";
import { PrivacyStateBadge } from "./privacy-state-badge";

/**
 * A list of privacy cases: reference, kind, state, the deadline (or the decision date for a decided
 * case), and whether identity is verified and an account is linked. Rows link to the case page.
 * Dates are pinned to UTC, because the deadline is a statutory date and the server renders it.
 */
export function PrivacyCaseTable({
	rows,
	decided = false,
	now,
}: {
	rows: PrivacyListRow[];
	/** Show the decision date instead of the deadline. */
	decided?: boolean;
	/** The instant "overdue" is measured against, from the server render. */
	now: Date;
}) {
	return (
		<Table>
			<TableHeader>
				<TableRow>
					<TableHead>Reference</TableHead>
					<TableHead>Kind</TableHead>
					<TableHead>State</TableHead>
					<TableHead>Received</TableHead>
					<TableHead>{decided ? "Decided" : "Due"}</TableHead>
					<TableHead>Identity</TableHead>
					<TableHead>Account</TableHead>
				</TableRow>
			</TableHeader>
			<TableBody>
				{rows.map((r) => {
					const overdue = !decided && new Date(r.dueAt).getTime() < now.getTime();
					return (
						<TableRow key={r.reference}>
							<TableCell>
								<Link href={`/privacy/${r.reference}`} className="font-mono hover:underline">
									{r.reference}
								</Link>
							</TableCell>
							<TableCell className="capitalize">{r.kind}</TableCell>
							<TableCell>
								<PrivacyStateBadge state={r.state} />
							</TableCell>
							<TableCell>{formatDate(r.receivedAt, "date", "UTC")}</TableCell>
							<TableCell>
								{decided ? (
									formatDate(r.decidedAt, "date", "UTC")
								) : (
									<span className={overdue ? "font-medium text-destructive" : undefined}>
										{formatDate(r.dueAt, "date", "UTC")}
										{overdue ? " · overdue" : ""}
										{r.extendedAt ? " · extended" : ""}
									</span>
								)}
							</TableCell>
							<TableCell>{r.identityVerifiedAt ? "verified" : "not verified"}</TableCell>
							<TableCell>
								{r.subjectUserId ? "linked" : "none"}
								{r.legalHoldReason ? " · on hold" : ""}
							</TableCell>
						</TableRow>
					);
				})}
			</TableBody>
		</Table>
	);
}
