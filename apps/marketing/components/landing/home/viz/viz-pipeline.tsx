// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

const STAGES: [string, number][] = [
	["REPO", 12],
	["PLAN", 114],
	["VERIFY", 216],
	["APPLY", 318],
	["CLUSTER", 408],
];

/**
 * viz-pipeline — the spine: repo → plan → verify → apply → running cluster, with
 * a proof token traveling the line. What you commit becomes owned, proven infra.
 */
export function VizPipeline() {
	const bs = "var(--border-strong)";
	return (
		<svg className="viz" viewBox="0 0 480 150" role="img" aria-label="A pipeline: repository to plan to verify to apply to a running cluster, with proof traveling along it.">
			{/* the flow line */}
			<line x1="72" y1="75" x2="408" y2="75" stroke="var(--border)" />

			{/* stages */}
			{STAGES.map(([name, x], i) => {
				const w = i === STAGES.length - 1 ? 64 : 60;
				return (
					<g key={name}>
						<rect x={x} y="50" width={w} height="50" fill="var(--surface)" stroke={bs} />
						<text x={x + w / 2} y="79" fontSize="9.5" letterSpacing="0.1em" textAnchor="middle" fill="var(--text-secondary)">{name}</text>
						{i === STAGES.length - 1 && <circle className="viz-cluster-dot" cx={x + w - 12} cy="62" r="3" fill="var(--text-primary)" />}
					</g>
				);
			})}

			{/* traveling proof token */}
			<g className="viz-flow">
				<g transform="translate(65 68)">
					<rect width="14" height="14" fill="var(--background)" stroke="var(--text-primary)" />
					<path d="M4 3 H2.5 V11 H4" stroke="var(--text-primary)" strokeWidth="1" fill="none" />
					<path d="M10 3 H11.5 V11 H10" stroke="var(--text-primary)" strokeWidth="1" fill="none" />
					<circle cx="7" cy="7" r="1.3" fill="var(--text-primary)" />
				</g>
			</g>
		</svg>
	);
}
