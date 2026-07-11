"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The cross-environment consistency matrix — which components each environment defines and where
// they diverge. ● present · ≠ differs · – absent.

import type { EnvConsistency } from "@/app/server/actions/projects";

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
			<div className="mb-3">
				<h2 className="m-0 font-display text-[15px] font-semibold tracking-tight text-text-primary">
					Consistency
				</h2>
				<p className="mt-1.5 text-[12.5px] text-text-tertiary">
					Which services each environment defines, and where they diverge.{" "}
					<span className="font-mono text-text-primary">●</span> present ·{" "}
					<span className="font-mono font-bold text-text-primary">≠</span> differs ·{" "}
					<span className="font-mono text-text-disabled">–</span> absent
				</p>
			</div>
			<div className="overflow-x-auto rounded-lg border bg-surface shadow-sm">
				<table className="w-full border-collapse text-[12.5px]">
					<thead>
						<tr className="bg-surface-muted">
							<th className="px-4 py-2.5 text-left font-mono text-[11px] uppercase tracking-[0.1em] text-text-tertiary">
								Component
							</th>
							{consistency.envs.map((e) => (
								<th
									key={e.id}
									className="px-3 py-2.5 text-center font-mono font-normal text-text-secondary"
								>
									{e.name}
								</th>
							))}
						</tr>
					</thead>
					<tbody>
						{consistency.rows.map((row) => (
							<tr
								key={`${row.component_type}-${row.key}`}
								className="border-t border-border-faint"
							>
								<td className="px-4 py-2.5">
									<span className="text-text-tertiary">{row.component_type}</span>{" "}
									<span className="font-mono text-text-primary">{row.key}</span>
								</td>
								{consistency.envs.map((e) => (
									<td key={e.id} className="px-3 py-2.5 text-center">
										<Cell state={row.perEnv[e.id]} />
									</td>
								))}
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</section>
	);
}
