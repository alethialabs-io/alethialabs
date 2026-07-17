// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * viz-canvas — the architecture graph draws itself: a VPC container, then
 * network → cluster → {database, cache, dns} nodes rise in staggered, edges
 * stroke in, the cluster pulses. An abstract, geometric echo of the real canvas.
 */
export function VizCanvas() {
	const bs = "var(--border-strong)";
	const lbl = { fontSize: 9, letterSpacing: "0.14em" } as const;
	return (
		<svg className="viz" viewBox="0 0 460 320" role="img" aria-label="An architecture canvas: a VPC containing a network, a Kubernetes cluster, and its database, cache, and DNS.">
			{/* VPC container */}
			<g className="viz-node">
				<rect x="24" y="24" width="412" height="272" fill="none" stroke="var(--border)" />
				<text x="36" y="44" style={lbl} fill="var(--text-disabled)">VPC · 10.0.0.0/16</text>
			</g>

			{/* edges (behind nodes) */}
			<g fill="none" stroke={bs}>
				<path className="viz-edge viz-edge-1" d="M112 104 V140" />
				<path className="viz-edge viz-edge-2" d="M188 158 H236 V132 H272" />
				<path className="viz-edge viz-edge-3" d="M188 176 H272" />
				<path className="viz-edge viz-edge-4" d="M188 190 H236 V236 H272" />
			</g>

			{/* nodes */}
			<g className="viz-node viz-node-1">
				<rect x="52" y="64" width="120" height="40" fill="var(--surface)" stroke={bs} />
				<text x="64" y="82" style={lbl}>NETWORK</text>
				<text x="64" y="96" fontSize="10" fill="var(--text-secondary)">10.0.0.0/16</text>
			</g>
			<g className="viz-node viz-node-2">
				<rect x="52" y="140" width="136" height="72" fill="var(--surface)" stroke={bs} />
				<text x="64" y="158" style={lbl}>CLUSTER</text>
				<text x="64" y="176" fontSize="11" fill="var(--text-primary)">k8s 1.31</text>
				<text x="64" y="194" fontSize="9.5" fill="var(--text-tertiary)">2–6 nodes</text>
				<circle className="viz-cluster-dot" cx="172" cy="152" r="3" fill="var(--text-primary)" />
			</g>
			<g className="viz-node viz-node-3">
				<rect x="272" y="112" width="140" height="40" fill="var(--surface)" stroke={bs} />
				<text x="284" y="130" style={lbl}>DATABASE</text>
				<text x="284" y="144" fontSize="10" fill="var(--text-secondary)">orders · Postgres</text>
			</g>
			<g className="viz-node viz-node-4">
				<rect x="272" y="164" width="140" height="40" fill="var(--surface)" stroke={bs} />
				<text x="284" y="182" style={lbl}>CACHE</text>
				<text x="284" y="196" fontSize="10" fill="var(--text-secondary)">sessions · Redis</text>
			</g>
			<g className="viz-node viz-node-5">
				<rect x="272" y="216" width="140" height="40" fill="var(--surface)" stroke={bs} />
				<text x="284" y="234" style={lbl}>DNS</text>
				<text x="284" y="248" fontSize="10" fill="var(--text-secondary)">payments.acme…</text>
			</g>
		</svg>
	);
}
