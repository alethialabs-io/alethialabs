"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The cross-environment consistency matrix — which components each environment defines and where
// they diverge. ● present · ≠ differs · – absent.
//
// This is the one shape in the lane that `DataTable` cannot express: the columns ARE the data
// (one per environment, discovered at render), and there is nothing to sort, filter or paginate.
// So it composes `@repo/ui/table` directly, which is the shell `DataTable` itself renders
// through — same padding, borders and hover as every other console table, and a real
// `<th scope>` per environment so a screen reader can name the cell it is reading.

import type { EnvConsistency } from "@/app/server/actions/projects";
import { SectionHeading } from "@repo/ui/section-heading";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@repo/ui/table";

/** One matrix cell. */
function Cell({ state }: { state: "present" | "differs" | "absent" }) {
	if (state === "present")
		return <span className="font-mono text-text-primary">●</span>;
	if (state === "differs")
		return (
			<span
				className="font-mono font-bold text-text-primary"
				title="Differs across environments"
			>
				≠
			</span>
		);
	return <span className="font-mono text-text-disabled">–</span>;
}

export function ConsistencyMatrix({ consistency }: { consistency: EnvConsistency }) {
	return (
		<section>
			<SectionHeading
				className="mb-3"
				level={2}
				title="Consistency"
				description={
					<>
						Which services each environment defines, and where they diverge.{" "}
						<span className="font-mono text-text-primary">●</span> present ·{" "}
						<span className="font-mono font-bold text-text-primary">≠</span> differs ·{" "}
						<span className="font-mono text-text-disabled">–</span> absent
					</>
				}
			/>
			<div className="overflow-hidden rounded-lg border bg-surface shadow-sm">
				<Table scroll className="text-[12.5px]">
					<TableHeader>
						<TableRow className="bg-surface-muted">
							<TableHead
								scope="col"
								className="font-mono text-[11px] uppercase tracking-[0.1em] text-text-tertiary"
							>
								Component
							</TableHead>
							{consistency.envs.map((e) => (
								<TableHead
									key={e.id}
									scope="col"
									className="text-center font-mono font-normal text-text-secondary"
								>
									{e.name}
								</TableHead>
							))}
						</TableRow>
					</TableHeader>
					<TableBody>
						{consistency.rows.map((row) => (
							<TableRow key={`${row.component_type}-${row.key}`}>
								<TableCell>
									<span className="text-text-tertiary">{row.component_type}</span>{" "}
									<span className="font-mono text-text-primary">{row.key}</span>
								</TableCell>
								{consistency.envs.map((e) => (
									<TableCell key={e.id} className="text-center">
										<Cell state={row.perEnv[e.id]} />
									</TableCell>
								))}
							</TableRow>
						))}
					</TableBody>
				</Table>
			</div>
		</section>
	);
}
