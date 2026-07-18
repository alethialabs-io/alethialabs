// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Six warm-pool cells: five fill in (staggered), one dies + heals; a rollout
// wave sweeps across. classes drive the motion (globals.css).
const CELLS = ["viz-cell", "viz-cell viz-cell-2", "viz-cell-heal", "viz-cell viz-cell-3", "viz-cell viz-cell-4", "viz-cell viz-cell-5"];

/**
 * viz-fleet — a warm pool of runners that keeps itself sized: cells fill to
 * demand, a dead node heals itself, and a rollout wave rolls new versions with
 * zero downtime.
 */
export function VizFleet() {
	const bs = "var(--border-strong)";
	return (
		<svg className="viz" viewBox="0 0 420 190" role="img" aria-label="A warm pool of runner cells that fills to demand, heals a dead node, and rolls out new versions.">
			<text x="20" y="34" fontSize="9" letterSpacing="0.14em" fill="var(--text-disabled)">FLEET · WARM POOL</text>

			{/* cells */}
			{CELLS.map((cls, i) => {
				const x = 20 + i * 62;
				return (
					<g key={i}>
						<rect x={x} y="58" width="50" height="62" fill="none" stroke={bs} />
						<rect className={cls} x={x + 5} y="63" width="40" height="52" fill="var(--text-tertiary)" />
					</g>
				);
			})}

			{/* rollout wave */}
			<rect className="viz-wave" x="12" y="52" width="28" height="74" fill="var(--text-primary)" opacity="0.12" />

			{/* readout */}
			<text x="20" y="150" fontSize="10.5" fill="var(--text-secondary)">5 / 6 online</text>
			<text x="120" y="150" fontSize="10.5" fill="var(--text-tertiary)">self-healing · zero-downtime rollout</text>
		</svg>
	);
}
