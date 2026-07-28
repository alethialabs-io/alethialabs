// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

"use client";

import { type CSSProperties, type ReactNode, useRef, useState } from "react";
import { motion, useMotionValueEvent, useTransform } from "motion/react";
import { STORY } from "@/components/landing/home/motion/storyboard";
import { SectionShell } from "@/components/landing/home/motion/section-shell";
import { Reveal } from "@/components/landing/home/motion/reveal";
import { usePrefersReducedMotion } from "@/components/landing/home/motion/use-reduced-motion";
import {
	stageFromProgress,
	useScrollScene,
} from "@/components/landing/home/motion/use-scroll-scene";
import { disp, Icon, type IconKey, Mark, mono } from "@/components/landing/home/primitives";

/**
 * Per-stage detail the storyboard doesn't carry (icon + the caption that reveals
 * as the proof token passes). Keyed by the stage id so the ordered stage list
 * still comes from `STORY.spine.stages` — no stage strings are re-typed here.
 */
const STAGE_DETAIL: Record<string, { caption: string; icon: IconKey }> = {
	repo: { caption: "your Project, in Git", icon: "git" },
	plan: { caption: "compiles to OpenTofu", icon: "layers" },
	verify: { caption: "fail-closed gate", icon: "shield" },
	apply: { caption: "sandboxed, streamed", icon: "zap" },
	cluster: { caption: "ArgoCD reconciles", icon: "server" },
};

const FALLBACK: { caption: string; icon: IconKey } = { caption: "", icon: "node" };

interface Stage {
	id: string;
	name: string;
	caption: string;
	icon: IconKey;
}

/** The ordered spine stages, resolved from the storyboard slice + local detail. */
const STAGES: Stage[] = STORY.spine.stages.map((id) => {
	const d = STAGE_DETAIL[id] ?? FALLBACK;
	return {
		id,
		name: id.charAt(0).toUpperCase() + id.slice(1),
		caption: d.caption,
		icon: d.icon,
	};
});

const N = STAGES.length;
const RAIL_Y = 168;
const STAGE_H = 336;

/** Left offset (as a CSS percentage) of the i-th node, inset from both edges. */
function nodeLeft(i: number): string {
	return `${((i + 0.5) / N) * 100}%`;
}

/** Two-digit, 1-based label for a zero-based index (e.g. 0 -> "01"). */
function pad(n: number): string {
	return String(n + 1).padStart(2, "0");
}

/**
 * One stage column — the label above the rail, the square node marker sitting on
 * it, and the caption below. `lit` drives the passed-through state; `active`
 * marks the node the token currently sits on. Pure presentation, shared by the
 * scrubbed and reduced-motion layouts.
 */
function StageColumn({
	stage,
	i,
	lit,
	active,
}: {
	stage: Stage;
	i: number;
	lit: boolean;
	active: boolean;
}) {
	const left = nodeLeft(i);
	return (
		<>
			{/* label above */}
			<div
				style={{
					position: "absolute",
					left,
					top: 84,
					transform: "translateX(-50%)",
					textAlign: "center",
					width: 150,
					transition: "opacity .35s ease",
					opacity: lit ? 1 : 0.4,
				}}
			>
				<div
					style={{
						...mono,
						fontSize: 10,
						letterSpacing: "0.18em",
						textTransform: "uppercase",
						color: "var(--text-tertiary)",
					}}
				>
					{pad(i)}
				</div>
				<div
					style={{
						...disp,
						fontSize: 16,
						fontWeight: 600,
						letterSpacing: "-0.01em",
						color: lit ? "var(--text-primary)" : "var(--text-tertiary)",
						transition: "color .35s ease",
					}}
				>
					{stage.name}
				</div>
			</div>

			{/* node marker on the rail */}
			<div
				style={{
					position: "absolute",
					left,
					top: RAIL_Y,
					transform: "translate(-50%, -50%)",
					zIndex: 2,
					display: "grid",
					placeItems: "center",
					width: 48,
					height: 48,
					borderRadius: "var(--radius-sm)",
					border: `1px solid ${lit ? "var(--text-primary)" : "var(--border)"}`,
					background: lit ? "var(--surface-raised)" : "var(--surface)",
					color: lit ? "var(--text-primary)" : "var(--text-disabled)",
					boxShadow: lit ? "var(--shadow-md)" : "none",
					outline: active ? "1px solid var(--border-strong)" : "none",
					outlineOffset: 4,
					transition:
						"border-color .35s ease, background .35s ease, color .35s ease, box-shadow .35s ease",
				}}
			>
				<Icon k={stage.icon} size={20} sw={1.7} />
			</div>

			{/* caption below */}
			<div
				style={{
					position: "absolute",
					left,
					top: RAIL_Y + 52,
					transform: `translateX(-50%) translateY(${lit ? 0 : 6}px)`,
					textAlign: "center",
					width: 158,
					fontSize: 12,
					lineHeight: 1.45,
					color: lit ? "var(--text-secondary)" : "var(--text-disabled)",
					opacity: lit ? 1 : 0.35,
					transition: "opacity .4s ease, transform .4s ease, color .4s ease",
				}}
			>
				{stage.caption}
			</div>
		</>
	);
}

/** The horizontal rail all node columns hang from, plus an optional bright fill. */
function Rail({ fill }: { fill: ReactNode }) {
	return (
		<>
			<div
				style={{
					position: "absolute",
					left: 0,
					right: 0,
					top: RAIL_Y - 0.5,
					height: 1,
					background: "var(--border-strong)",
					zIndex: 1,
				}}
			/>
			{fill}
		</>
	);
}

/**
 * The scrubbed spine — a sticky, full-viewport stage a proof token sweeps
 * across, lighting each node and revealing its caption as it passes. The tall
 * outer container drives scroll progress via `useScrollScene`.
 */
function ScrubSpine() {
	const scrollRef = useRef<HTMLDivElement>(null);
	const { progress } = useScrollScene(scrollRef);
	const [active, setActive] = useState(0);

	// One sweep value drives both the token's position and the rail fill width.
	const sweep = useTransform(progress, [0, 1], ["0%", "100%"]);

	useMotionValueEvent(progress, "change", (p) => {
		setActive(stageFromProgress(p, N));
	});

	const current = STAGES[active] ?? STAGES[0];

	return (
		<div ref={scrollRef} style={{ position: "relative", height: "240vh" }}>
			<div
				style={{
					position: "sticky",
					top: 0,
					height: "100vh",
					display: "flex",
					flexDirection: "column",
					justifyContent: "center",
					overflow: "hidden",
				}}
			>
				{/* blueprint grid backdrop */}
				<div
					className="ah-grid-bg"
					aria-hidden
					style={{
						position: "absolute",
						inset: 0,
						opacity: 0.5,
						pointerEvents: "none",
						maskImage:
							"radial-gradient(120% 80% at 50% 45%, black 40%, transparent 100%)",
					}}
				/>

				{/* readout — active stage synced to the token */}
				<div
					style={{
						position: "relative",
						display: "flex",
						alignItems: "center",
						gap: 12,
						alignSelf: "center",
						marginBottom: 40,
						padding: "7px 14px",
						border: "1px solid var(--border)",
						borderRadius: "var(--radius-sm)",
						background: "var(--surface-raised)",
						boxShadow: "var(--shadow-md)",
					}}
				>
					<span className="ah-pulse" />
					<span
						style={{
							...mono,
							fontSize: 11,
							letterSpacing: "0.12em",
							color: "var(--text-primary)",
						}}
					>
						{pad(active)} / {String(N).padStart(2, "0")}
					</span>
					<span style={{ width: 3, height: 3, borderRadius: 999, background: "var(--text-disabled)" }} />
					<span
						style={{
							...mono,
							fontSize: 11,
							letterSpacing: "0.06em",
							color: "var(--text-secondary)",
						}}
					>
						{current.id} · {current.caption}
					</span>
				</div>

				{/* the stage: rail + nodes + traveling proof token */}
				<div style={{ position: "relative", height: STAGE_H, width: "100%" }}>
					<Rail
						fill={
							<motion.div
								style={{
									position: "absolute",
									left: 0,
									top: RAIL_Y - 1,
									height: 2,
									width: sweep,
									background: "var(--text-primary)",
									zIndex: 1,
								}}
							/>
						}
					/>

					{STAGES.map((s, i) => (
						<StageColumn
							key={s.id}
							stage={s}
							i={i}
							lit={i <= active}
							active={i === active}
						/>
					))}

					{/* proof token — the [·] mark riding the spine */}
					<motion.div
						aria-hidden
						style={{
							position: "absolute",
							left: sweep,
							top: RAIL_Y,
							transform: "translate(-50%, -50%)",
							zIndex: 3,
							display: "grid",
							placeItems: "center",
							width: 34,
							height: 34,
							borderRadius: "var(--radius-sm)",
							background: "var(--ink)",
							color: "var(--ink-foreground)",
							boxShadow: "var(--shadow-lg)",
						}}
					>
						<Mark size={18} />
					</motion.div>
				</div>
			</div>
		</div>
	);
}

/**
 * Reduced-motion fallback — the whole spine at rest: all five stages fully lit
 * across a single static rail, every caption legible, no stickiness.
 */
function StaticSpine() {
	return (
		<div style={{ position: "relative", height: STAGE_H, width: "100%", marginTop: 24 }}>
			<Rail
				fill={
					<div
						style={{
							position: "absolute",
							left: 0,
							top: RAIL_Y - 1,
							height: 2,
							width: "100%",
							background: "var(--text-primary)",
							zIndex: 1,
						}}
					/>
				}
			/>
			{STAGES.map((s, i) => (
				<StageColumn key={s.id} stage={s} i={i} lit active={false} />
			))}
		</div>
	);
}

const lineStyle: CSSProperties = {
	fontSize: 15,
	lineHeight: 1.6,
	color: "var(--text-secondary)",
	margin: "0 0 8px",
	maxWidth: 640,
};

/**
 * Section 02 — "The spine": the scroll-scrubbed beat that walks a signed proof
 * token from repo to a running cluster, lighting each stage as it passes.
 */
export function Spine() {
	const reduced = usePrefersReducedMotion();

	return (
		<SectionShell
			id="spine"
			n={STORY.spine.n}
			label={STORY.spine.label}
			title={STORY.spine.title}
		>
			<Reveal>
				<p style={lineStyle}>{STORY.spine.line}</p>
			</Reveal>
			{reduced ? <StaticSpine /> : <ScrubSpine />}
		</SectionShell>
	);
}
