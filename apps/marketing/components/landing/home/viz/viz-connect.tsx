// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

const CLOUDS: [string, number][] = [
	["AWS", 60],
	["GCP", 137],
	["HETZNER", 214],
];

/**
 * viz-connect — keyless: a central [·] hub mints short-lived token chips that
 * travel to AWS / GCP / Hetzner and then dissolve. Nothing is stored; the lock
 * stays open and empty.
 */
export function VizConnect() {
	const bs = "var(--border-strong)";
	return (
		<svg className="viz" viewBox="0 0 420 300" role="img" aria-label="A central Alethia hub mints short-lived federated tokens for AWS, GCP, and Hetzner — no keys stored.">
			{/* connectors */}
			<g fill="none" stroke="var(--border)">
				<path d="M112 154 L270 77" />
				<path d="M112 154 L270 154" />
				<path d="M112 154 L270 231" />
			</g>

			{/* hub with the [·] mark */}
			<g className="viz-hub">
				<rect x="56" y="126" width="56" height="56" fill="var(--surface)" stroke="var(--text-primary)" />
				<path d="M74 140 H70 V168 H74" stroke="var(--text-primary)" strokeWidth="1.6" fill="none" strokeLinecap="round" />
				<path d="M94 140 H98 V168 H94" stroke="var(--text-primary)" strokeWidth="1.6" fill="none" strokeLinecap="round" />
				<circle cx="84" cy="154" r="3.2" fill="var(--text-primary)" />
			</g>
			<text x="84" y="200" fontSize="9" letterSpacing="0.14em" textAnchor="middle" fill="var(--text-tertiary)">ALETHIA</text>

			{/* open, empty lock */}
			<g transform="translate(40 236)">
				<rect x="0" y="8" width="16" height="12" fill="none" stroke={bs} />
				<path d="M3 8 V5 a5 5 0 0 1 10 0" fill="none" stroke={bs} />
				<text x="24" y="18" fontSize="9.5" fill="var(--text-tertiary)">no keys stored</text>
			</g>

			{/* clouds */}
			{CLOUDS.map(([name, y]) => (
				<g key={name}>
					<rect x="270" y={y} width="120" height="34" fill="var(--surface)" stroke={bs} />
					<text x="286" y={y + 21} fontSize="11" fill="var(--text-secondary)">{name}</text>
				</g>
			))}

			{/* short-lived tokens (mint → travel → dissolve) */}
			{["viz-tok-a", "viz-tok-b", "viz-tok-c"].map((cls) => (
				<g key={cls} className={cls}>
					<g transform="translate(116 147)">
						<rect width="15" height="15" fill="var(--surface)" stroke="var(--text-primary)" strokeDasharray="2 2" />
						<circle cx="7.5" cy="7.5" r="1.6" fill="var(--text-primary)" />
					</g>
				</g>
			))}
		</svg>
	);
}
