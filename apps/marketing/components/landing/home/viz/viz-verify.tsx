// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

const CONTROLS = ["keyless", "oidc subject", "least-privilege", "no public db", "encrypted"];

/**
 * viz-verify — the prove-it wedge: a plan flows into a fail-closed gate where
 * controls check off one-by-one under a downward scan line, then a signed
 * ed25519 receipt seal stamps in. The differentiator, made geometric.
 */
export function VizVerify() {
	const bs = "var(--border-strong)";
	const lbl = { fontSize: 9, letterSpacing: "0.14em" } as const;
	return (
		<svg className="viz" viewBox="0 0 460 300" role="img" aria-label="A plan is verified by a fail-closed gate — controls pass one by one — then a signed ed25519 receipt is issued.">
			{/* connectors */}
			<g fill="none" stroke={bs}>
				<path d="M132 150 H176" />
				<path d="M324 150 H340" />
			</g>

			{/* PLAN */}
			<g>
				<rect x="16" y="104" width="116" height="92" fill="var(--surface)" stroke={bs} />
				<text x="28" y="124" style={lbl} fill="var(--text-disabled)">PLAN</text>
				<text x="28" y="146" fontSize="12" fill="var(--text-primary)">47 to add</text>
				<text x="28" y="164" fontSize="10.5" fill="var(--text-tertiary)">0 change</text>
				<text x="28" y="180" fontSize="10.5" fill="var(--text-tertiary)">0 destroy</text>
			</g>

			{/* GATE */}
			<g>
				<rect x="176" y="60" width="148" height="180" fill="var(--surface)" stroke={bs} />
				<text x="188" y="80" style={lbl} fill="var(--text-disabled)">VERIFY · FAIL-CLOSED</text>
				{CONTROLS.map((c, i) => {
					const y = 104 + i * 26;
					return (
						<g key={c}>
							<rect x="188" y={y - 8} width="9" height="9" fill="none" stroke={bs} />
							<path className={`viz-check viz-check-${i + 1}`} d={`M${188.5} ${y - 3.5} l2.6 2.8 l4.6 -5`} fill="none" stroke="var(--text-primary)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
							<text x="204" y={y} fontSize="10.5" fill="var(--text-secondary)">{c}</text>
						</g>
					);
				})}
				{/* scan line */}
				<g className="viz-scan">
					<line x1="178" y1="66" x2="322" y2="66" stroke="var(--text-primary)" strokeOpacity="0.5" />
				</g>
			</g>

			{/* RECEIPT */}
			<g>
				<rect x="340" y="92" width="108" height="120" fill="var(--surface)" stroke={bs} />
				<text x="352" y="112" style={lbl} fill="var(--text-disabled)">RECEIPT</text>
				{/* signed seal */}
				<g className="viz-seal">
					<rect x="352" y="122" width="30" height="30" fill="none" stroke="var(--text-primary)" />
					<path d="M360 137 H360.5 V145 H360" stroke="var(--text-primary)" strokeWidth="1.4" fill="none" />
					<path d="M374 137 H373.5 V145 H374" stroke="var(--text-primary)" strokeWidth="1.4" fill="none" />
					<circle cx="367" cy="141" r="1.8" fill="var(--text-primary)" />
				</g>
				<g className="viz-hash">
					<text x="352" y="172" fontSize="9.5" fill="var(--text-tertiary)">ed25519</text>
					<text x="352" y="187" fontSize="9.5" fill="var(--text-secondary)">9f3c…a71b</text>
					<text x="352" y="202" fontSize="9.5" fill="var(--text-tertiary)">6 / 6 pass</text>
				</g>
			</g>
		</svg>
	);
}
