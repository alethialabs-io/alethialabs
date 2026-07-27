// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

"use client";

import { type CSSProperties } from "react";
import { motion } from "motion/react";
import { STORY } from "@/components/landing/home/motion/storyboard";
import { SectionShell } from "@/components/landing/home/motion/section-shell";
import { Reveal, stagger } from "@/components/landing/home/motion/reveal";
import { Stamp } from "@/components/landing/home/motion/stamp";
import { usePrefersReducedMotion } from "@/components/landing/home/motion/use-reduced-motion";
import { disp, Icon, type IconKey, mono } from "@/components/landing/home/primitives";

/** One node in a path's mini-flow: an icon, a structural label, and a sub-line. */
interface FlowStep {
	k: IconKey;
	label: string;
	sub: string;
	stamp?: boolean;
}

/** Path B (live) — bring your own OpenTofu, gated, then applied on your cloud. */
const PATH_B: FlowStep[] = [
	{ k: "git", label: "Your module", sub: "OpenTofu root, your repo" },
	{ k: "shield", label: "Fail-closed gate", sub: "a verdict on the plan", stamp: true },
	{ k: "layers", label: "Apply", sub: "on your cloud, keyless" },
];

/** Path A (roadmap) — scan a repo, infer the infra, propose a Project. */
const PATH_A: FlowStep[] = [
	{ k: "scan", label: "Scan", sub: "reads the code" },
	{ k: "sparkles", label: "Infer", sub: "the backing infra" },
	{ k: "pen", label: "Propose", sub: "a Project to shape" },
];

const CONNECTOR_H = 26;

/**
 * A grayscale dot that travels the live connector once per loop; renders nothing
 * under reduced motion, leaving the static hairline as the legible fallback.
 */
function FlowPulse() {
	const reduced = usePrefersReducedMotion();
	if (reduced) return null;
	return (
		<motion.span
			aria-hidden
			style={{
				position: "absolute",
				left: -2,
				top: 0,
				width: 5,
				height: 5,
				borderRadius: 999,
				background: "var(--text-primary)",
			}}
			initial={{ y: 0, opacity: 0 }}
			animate={{ y: CONNECTOR_H, opacity: [0, 1, 1, 0] }}
			transition={{ duration: 1.6, ease: "easeInOut", repeat: Infinity, repeatDelay: 0.5 }}
		/>
	);
}

/** The hairline that joins two steps — solid+animated when live, dashed when coming. */
function Connector({ coming }: { coming: boolean }) {
	if (coming) {
		return (
			<div
				aria-hidden
				style={{ marginLeft: 17, height: CONNECTOR_H, width: 0, borderLeft: "1px dashed var(--border-strong)" }}
			/>
		);
	}
	return (
		<div
			aria-hidden
			style={{ position: "relative", marginLeft: 17, height: CONNECTOR_H, width: 1, background: "var(--border-strong)" }}
		>
			<FlowPulse />
		</div>
	);
}

/** A single step row: squared icon cell, mono label, muted sub, optional verdict stamp. */
function Step({ step, coming }: { step: FlowStep; coming: boolean }) {
	const labelColor = coming ? "var(--text-tertiary)" : "var(--text-primary)";
	return (
		<div style={{ display: "flex", alignItems: "center", gap: 14 }}>
			<span
				style={{
					display: "grid",
					placeItems: "center",
					width: 34,
					height: 34,
					flexShrink: 0,
					borderRadius: "var(--radius-sm)",
					border: coming ? "1px dashed var(--border-strong)" : "1px solid var(--border)",
					background: "var(--surface-sunken)",
					color: coming ? "var(--text-tertiary)" : "var(--text-primary)",
				}}
			>
				<Icon k={step.k} size={16} />
			</span>
			<span style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
				<span style={{ ...mono, fontSize: 12, letterSpacing: "0.04em", color: labelColor }}>{step.label}</span>
				<span style={{ fontSize: 11.5, color: "var(--text-tertiary)", lineHeight: 1.4 }}>{step.sub}</span>
			</span>
			{step.stamp ? (
				<Stamp delay={0.15} style={{ marginLeft: "auto" }}>
					<span
						style={{
							display: "inline-flex",
							alignItems: "center",
							gap: 6,
							padding: "3px 9px",
							borderRadius: "var(--radius-xs)",
							border: "1px solid var(--border-strong)",
							background: "var(--surface)",
							...mono,
							fontSize: 9.5,
							letterSpacing: "0.1em",
							textTransform: "uppercase",
							color: "var(--text-secondary)",
						}}
					>
						<Icon k="check" size={11} sw={2.4} />
						passed
					</span>
				</Stamp>
			) : null}
		</div>
	);
}

/** The vertical pipeline for one path — steps joined by connectors, staggered in. */
function MiniFlow({ steps, coming }: { steps: FlowStep[]; coming: boolean }) {
	return (
		<div style={{ display: "flex", flexDirection: "column" }}>
			{steps.map((step, i) => (
				<Reveal key={step.label} delay={stagger(i, 0.08)} y={10}>
					<Step step={step} coming={coming} />
					{i < steps.length - 1 ? <Connector coming={coming} /> : null}
				</Reveal>
			))}
		</div>
	);
}

/** The mono status pill in a card header: a live pulse or the bordered "Coming" tag. */
function StatusPill({ coming }: { coming: boolean }) {
	if (coming) {
		return (
			<span
				style={{
					display: "inline-flex",
					alignItems: "center",
					gap: 7,
					padding: "4px 10px",
					borderRadius: "var(--radius-xs)",
					border: "1px dashed var(--border-strong)",
					...mono,
					fontSize: 9.5,
					letterSpacing: "0.14em",
					textTransform: "uppercase",
					color: "var(--text-tertiary)",
				}}
			>
				{STORY.flows.aBadge}
			</span>
		);
	}
	return (
		<span
			style={{
				display: "inline-flex",
				alignItems: "center",
				gap: 8,
				padding: "4px 10px",
				borderRadius: "var(--radius-xs)",
				border: "1px solid var(--border-strong)",
				...mono,
				fontSize: 9.5,
				letterSpacing: "0.14em",
				textTransform: "uppercase",
				color: "var(--text-secondary)",
			}}
		>
			<span className="ah-pulse" />
			Live
		</span>
	);
}

/** One flow card: an eyebrow + status pill header, title, line, and its mini-flow. */
function FlowCard({
	path,
	title,
	line,
	steps,
	coming,
	delay,
}: {
	path: string;
	title: string;
	line: string;
	steps: FlowStep[];
	coming: boolean;
	delay: number;
}) {
	const cardStyle: CSSProperties = {
		display: "flex",
		flexDirection: "column",
		height: "100%",
		padding: 28,
		borderRadius: "var(--radius-md)",
		border: coming ? "1px dashed var(--border-strong)" : "1px solid var(--border)",
		background: coming ? "var(--surface-sunken)" : "var(--surface)",
		boxShadow: coming ? "none" : "var(--shadow-md)",
		opacity: coming ? 0.72 : 1,
	};
	return (
		<Reveal delay={delay} y={20} style={{ height: "100%" }}>
			<div style={cardStyle}>
				<div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 18 }}>
					<span style={{ ...mono, fontSize: 11, letterSpacing: "0.18em", textTransform: "uppercase", color: "var(--text-disabled)" }}>
						{path}
					</span>
					<StatusPill coming={coming} />
				</div>
				<h3 style={{ ...disp, fontSize: 22, fontWeight: 600, letterSpacing: "-0.02em", lineHeight: 1.15, color: "var(--text-primary)", margin: "0 0 12px" }}>
					{title}
				</h3>
				<p style={{ fontSize: 14, lineHeight: 1.6, color: "var(--text-tertiary)", margin: 0 }}>{line}</p>
				<div style={{ height: 1, background: "var(--border-faint)", margin: "24px 0" }} />
				<MiniFlow steps={steps} coming={coming} />
			</div>
		</Reveal>
	);
}

/**
 * Section 07 — "Two flows": Path B (bring your own IaC, live) and Path A
 * (generate from a repo scan, roadmap) rendered side by side, the roadmap path
 * held to visual honesty with dashed borders, reduced opacity, and the "Coming"
 * tag straight from STORY.
 */
export function Flows() {
	return (
		<SectionShell n={STORY.flows.n} label={STORY.flows.label} muted>
			<div
				style={{
					display: "grid",
					gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
					gap: 24,
					alignItems: "stretch",
				}}
			>
				<FlowCard
					path="Path B"
					title={STORY.flows.bTitle}
					line={STORY.flows.bLine}
					steps={PATH_B}
					coming={false}
					delay={0}
				/>
				<FlowCard
					path="Path A"
					title={STORY.flows.aTitle}
					line={STORY.flows.aLine}
					steps={PATH_A}
					coming
					delay={stagger(1, 0.08)}
				/>
			</div>
		</SectionShell>
	);
}
