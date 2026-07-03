// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Grayscale circular usage gauge for the overview Usage card. Near-limit (≥85%) reads via
// ink weight (heavier stroke + primary text), never hue — matching the design system's
// no-color rule.

/** A small circular percent gauge. `used`/`limit` drive the arc; the center shows %. */
export function UsageRing({
	used,
	limit,
	size = 40,
}: {
	used: number;
	limit: number;
	size?: number;
}) {
	const pct = limit > 0 ? Math.min(used / limit, 1) : 0;
	const near = pct >= 0.85;
	const r = (size - 6) / 2;
	const circumference = 2 * Math.PI * r;
	const offset = circumference * (1 - pct);
	const strokeWidth = near ? 4 : 3.2;

	return (
		<svg
			width={size}
			height={size}
			viewBox={`0 0 ${size} ${size}`}
			className="shrink-0"
			aria-hidden
		>
			<circle
				cx={size / 2}
				cy={size / 2}
				r={r}
				fill="none"
				stroke="var(--border-strong)"
				strokeWidth={strokeWidth}
			/>
			<circle
				cx={size / 2}
				cy={size / 2}
				r={r}
				fill="none"
				stroke={near ? "var(--text-primary)" : "var(--text-secondary)"}
				strokeWidth={strokeWidth}
				strokeDasharray={circumference}
				strokeDashoffset={offset}
				strokeLinecap="round"
				style={{
					transformOrigin: "50% 50%",
					transform: "rotate(-90deg)",
					transition: "stroke-dashoffset 0.5s cubic-bezier(0.2,0,0,1)",
				}}
			/>
			<text
				x="50%"
				y="50%"
				textAnchor="middle"
				dominantBaseline="central"
				fontFamily="var(--font-mono)"
				fontSize="9"
				fontWeight={near ? 600 : 400}
				fill={near ? "var(--text-primary)" : "var(--text-tertiary)"}
			>
				{Math.round(pct * 100)}
			</text>
		</svg>
	);
}
