// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

"use client";

import { type CSSProperties } from "react";
import { motion } from "motion/react";
import { LockOpen } from "lucide-react";
import { ProviderIcon } from "@repo/ui/provider-icon";
import { STORY } from "../motion/storyboard";
import { SectionShell } from "../motion/section-shell";
import { Reveal, stagger } from "../motion/reveal";
import { usePrefersReducedMotion } from "../motion/use-reduced-motion";
import { disp, eyebrow, Icon, Mark, mono } from "../primitives";

/** Corner coordinates (stage %) for the four cloud marks, in STORY.keyless.clouds order. */
const LAYOUT: ReadonlyArray<{ x: number; y: number }> = [
	{ x: 17, y: 24 },
	{ x: 83, y: 24 },
	{ x: 17, y: 76 },
	{ x: 83, y: 76 },
];

/** Short-lived federated-identity mechanism minted per cloud, in STORY.keyless.clouds order. */
const MECH: readonly string[] = ["AssumeRole", "WIF", "Fed. Identity", "OIDC"];

const HUB: { x: number; y: number } = { x: 50, y: 50 };
const TOKEN_W = 104;
const TOKEN_H = 26;

/** Keyframe phase boundaries: mint at hub → travel → dissolve at the cloud. */
const PHASE: number[] = [0, 0.12, 0.72, 1];
const CYCLE = 2.7;

/** A minted, short-lived credential chip travelling from the hub out to one cloud. */
function Token({
	mech,
	x,
	y,
	delay,
	animated,
}: {
	mech: string;
	x: number;
	y: number;
	delay: number;
	animated: boolean;
}) {
	const chip = (
		<>
			<span
				aria-hidden
				style={{
					width: 4,
					height: 4,
					flexShrink: 0,
					background: "var(--text-primary)",
					borderRadius: "var(--radius-xs)",
				}}
			/>
			<span
				style={{
					...mono,
					fontSize: 9,
					letterSpacing: "0.02em",
					color: "var(--text-secondary)",
					whiteSpace: "nowrap",
				}}
			>
				{mech}
			</span>
			<span
				style={{
					...mono,
					fontSize: 8,
					letterSpacing: "0.12em",
					textTransform: "uppercase",
					color: "var(--text-disabled)",
					marginLeft: "auto",
				}}
			>
				15m
			</span>
		</>
	);

	const box: CSSProperties = {
		position: "absolute",
		zIndex: 2,
		width: TOKEN_W,
		height: TOKEN_H,
		marginLeft: -TOKEN_W / 2,
		marginTop: -TOKEN_H / 2,
		display: "flex",
		alignItems: "center",
		gap: 6,
		padding: "0 9px",
		border: "1px solid var(--border-strong)",
		borderRadius: "var(--radius-sm)",
		background: "var(--surface-raised)",
		boxShadow: "var(--shadow-md)",
	};

	// Static fallback: the token frozen mid-flight, plainly legible.
	if (!animated) {
		const mid = 0.52;
		return (
			<div
				style={{
					...box,
					left: `${HUB.x + (x - HUB.x) * mid}%`,
					top: `${HUB.y + (y - HUB.y) * mid}%`,
				}}
			>
				{chip}
			</div>
		);
	}

	return (
		<motion.div
			style={box}
			initial={{ left: `${HUB.x}%`, top: `${HUB.y}%`, opacity: 0, scale: 0.62 }}
			animate={{
				left: [`${HUB.x}%`, `${HUB.x}%`, `${x}%`, `${x}%`],
				top: [`${HUB.y}%`, `${HUB.y}%`, `${y}%`, `${y}%`],
				opacity: [0, 1, 1, 0],
				scale: [0.62, 1, 1, 0.5],
			}}
			transition={{
				duration: CYCLE,
				times: PHASE,
				ease: "easeInOut",
				repeat: Infinity,
				repeatDelay: 0.5,
				delay,
			}}
		>
			{chip}
		</motion.div>
	);
}

/** A cloud endpoint mark, grayscale, that receives (and never retains) minted tokens. */
function CloudNode({ id, x, y }: { id: string; x: number; y: number }) {
	return (
		<div
			style={{
				position: "absolute",
				left: `${x}%`,
				top: `${y}%`,
				zIndex: 3,
				transform: "translate(-50%, -50%)",
				display: "flex",
				flexDirection: "column",
				alignItems: "center",
				gap: 8,
			}}
		>
			<span
				style={{
					display: "grid",
					placeItems: "center",
					width: 52,
					height: 52,
					border: "1px solid var(--border)",
					borderRadius: "var(--radius-md)",
					background: "var(--surface)",
					boxShadow: "var(--shadow-md)",
				}}
			>
				<ProviderIcon provider={id} size={24} />
			</span>
			<span
				style={{
					...mono,
					fontSize: 9,
					letterSpacing: "0.14em",
					textTransform: "uppercase",
					color: "var(--text-tertiary)",
				}}
			>
				{id}
			</span>
		</div>
	);
}

/** The central control-plane hub: mints tokens, and visibly holds zero keys. */
function Hub() {
	return (
		<div
			style={{
				position: "absolute",
				left: `${HUB.x}%`,
				top: `${HUB.y}%`,
				zIndex: 4,
				transform: "translate(-50%, -50%)",
				width: 150,
				border: "1px solid var(--border-strong)",
				borderRadius: "var(--radius-md)",
				background: "var(--surface-raised)",
				boxShadow: "var(--shadow-lg)",
				overflow: "hidden",
			}}
		>
			<div
				style={{
					display: "flex",
					alignItems: "center",
					gap: 9,
					padding: "11px 12px",
					color: "var(--text-primary)",
				}}
			>
				<Mark size={22} />
				<span
					style={{
						...mono,
						fontSize: 9,
						letterSpacing: "0.16em",
						textTransform: "uppercase",
						color: "var(--text-tertiary)",
					}}
				>
					control plane
				</span>
				<span className="ah-pulse" style={{ marginLeft: "auto" }} />
			</div>
			<div
				style={{
					display: "flex",
					alignItems: "center",
					gap: 8,
					padding: "9px 12px",
					borderTop: "1px solid var(--border-faint)",
					background: "var(--surface-sunken)",
					color: "var(--text-secondary)",
				}}
			>
				<LockOpen size={13} strokeWidth={1.7} />
				<span
					style={{
						...mono,
						fontSize: 9,
						letterSpacing: "0.1em",
						textTransform: "uppercase",
						color: "var(--text-tertiary)",
					}}
				>
					keys held
				</span>
				<span
					style={{
						...mono,
						fontSize: 15,
						fontWeight: 600,
						lineHeight: 1,
						color: "var(--text-primary)",
						marginLeft: "auto",
					}}
				>
					0
				</span>
			</div>
		</div>
	);
}

/** The keyless mint/dissolve diagram: hub → tokens → clouds, holding nothing. */
function KeylessDiagram() {
	const reduced = usePrefersReducedMotion();
	const clouds = STORY.keyless.clouds;

	return (
		<div
			style={{
				position: "relative",
				width: "100%",
				maxWidth: 520,
				aspectRatio: "1 / 1",
				marginLeft: "auto",
				border: "1px solid var(--border)",
				borderRadius: "var(--radius-md)",
				background: "var(--surface)",
				overflow: "hidden",
			}}
		>
			{/* Faint blueprint grid — the one background motif. */}
			<div
				aria-hidden
				style={{
					position: "absolute",
					inset: 0,
					backgroundImage:
						"linear-gradient(var(--border-faint) 1px, transparent 1px), linear-gradient(90deg, var(--border-faint) 1px, transparent 1px)",
					backgroundSize: "34px 34px",
					WebkitMaskImage:
						"radial-gradient(ellipse 78% 78% at 50% 50%, #000 42%, transparent 82%)",
					maskImage:
						"radial-gradient(ellipse 78% 78% at 50% 50%, #000 42%, transparent 82%)",
				}}
			/>

			{/* Hub → cloud hairlines (dashed blueprint routes). */}
			<svg
				aria-hidden
				viewBox="0 0 100 100"
				preserveAspectRatio="none"
				style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}
			>
				{clouds.map((id, i) => {
					const p = LAYOUT[i] ?? HUB;
					return (
						<line
							key={id}
							x1={HUB.x}
							y1={HUB.y}
							x2={p.x}
							y2={p.y}
							stroke="var(--border-strong)"
							strokeWidth={1}
							strokeDasharray="2 3"
							vectorEffect="non-scaling-stroke"
						/>
					);
				})}
			</svg>

			{clouds.map((id, i) => {
				const p = LAYOUT[i] ?? HUB;
				return <CloudNode key={id} id={id} x={p.x} y={p.y} />;
			})}

			{clouds.map((id, i) => {
				const p = LAYOUT[i] ?? HUB;
				return (
					<Token
						key={id}
						mech={MECH[i] ?? "Token"}
						x={p.x}
						y={p.y}
						delay={stagger(i, CYCLE / clouds.length)}
						animated={!reduced}
					/>
				);
			})}

			<Hub />
		</div>
	);
}

/** Section 01 "Own it" — keyless federated identity: your clouds, zero stored keys. */
export function Keyless() {
	const copy = STORY.keyless;

	return (
		<SectionShell n={copy.n} label={copy.label} muted id="keyless">
			<div
				style={{
					display: "flex",
					flexWrap: "wrap",
					alignItems: "center",
					gap: 56,
				}}
			>
				{/* Left: the argument. */}
				<div style={{ flex: "1 1 360px", minWidth: 300 }}>
					<Reveal>
						<h2
							style={{
								...disp,
								fontFamily: "var(--font-grotesk)",
								fontSize: 34,
								lineHeight: 1.1,
								fontWeight: 600,
								letterSpacing: "-0.02em",
								color: "var(--text-primary)",
								margin: "0 0 20px",
								maxWidth: 480,
							}}
						>
							{copy.title}
						</h2>
					</Reveal>

					<Reveal delay={0.06}>
						<p
							style={{
								fontSize: 15,
								lineHeight: 1.6,
								color: "var(--text-secondary)",
								margin: "0 0 28px",
								maxWidth: 480,
							}}
						>
							{copy.line}
						</p>
					</Reveal>

					<ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 12 }}>
						{copy.points.map((point, i) => (
							<Reveal key={point} delay={stagger(i, 0.07, 0.14)}>
								<li style={{ display: "flex", alignItems: "center", gap: 12 }}>
									<span
										style={{
											display: "grid",
											placeItems: "center",
											width: 24,
											height: 24,
											flexShrink: 0,
											border: "1px solid var(--border)",
											borderRadius: "var(--radius-sm)",
											background: "var(--surface-sunken)",
											color: "var(--text-primary)",
										}}
									>
										<Icon k="check" size={13} sw={2} />
									</span>
									<span style={{ fontSize: 14, color: "var(--text-secondary)" }}>{point}</span>
								</li>
							</Reveal>
						))}
					</ul>

					<Reveal delay={0.32}>
						<div
							style={{
								display: "inline-flex",
								alignItems: "center",
								gap: 9,
								marginTop: 30,
								padding: "7px 12px",
								border: "1px solid var(--border)",
								borderRadius: "var(--radius-sm)",
								background: "var(--surface)",
							}}
						>
							<LockOpen size={13} strokeWidth={1.7} style={{ color: "var(--text-tertiary)" }} />
							<span style={{ ...mono, fontSize: 11, letterSpacing: "0.04em", color: "var(--text-secondary)" }}>
								keys held: <span style={{ color: "var(--text-primary)" }}>0</span>
							</span>
						</div>
					</Reveal>
				</div>

				{/* Right: the diagram. */}
				<Reveal delay={0.1} y={20} style={{ flex: "1 1 400px", minWidth: 300 }}>
					<div style={{ marginBottom: 12 }}>
						<span style={{ ...eyebrow }}>Token mint · per operation</span>
					</div>
					<KeylessDiagram />
				</Reveal>
			</div>
		</SectionShell>
	);
}
