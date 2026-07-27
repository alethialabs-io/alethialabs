// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

"use client";

import { type CSSProperties, useEffect, useRef, useState } from "react";
import { useInView } from "motion/react";
import { STORY } from "../motion/storyboard";
import { SectionShell } from "../motion/section-shell";
import { Reveal, stagger } from "../motion/reveal";
import { usePrefersReducedMotion } from "../motion/use-reduced-motion";
import {
	disp,
	eyebrow,
	Icon,
	type IconKey,
	mono,
	Prov,
	type ProviderId,
} from "../primitives";

/* ------------------------------------------------------------------ *
 * Choreography — one global beat drives two coupled loops:            *
 *   • the runner pools ramp to demand, lose a node, self-heal, and    *
 *     roll themselves in a sweeping wave;                             *
 *   • the drift reconciler flips in_sync → drifted → reconciling and  *
 *     re-proves the cluster.                                          *
 * Every beat is derived, so `prefers-reduced-motion` just pins the    *
 * beat to a steady, fully-legible frame.                             *
 * ------------------------------------------------------------------ */

const CYCLE = 20;
const BEAT_MS = 860;

/** Positive modulo so negative beats never leak a negative index. */
function mod(n: number, m: number): number {
	return ((n % m) + m) % m;
}

/** Ticks a monotonic beat counter while `active`; frozen otherwise. */
function useBeat(active: boolean): number {
	const [beat, setBeat] = useState(0);
	useEffect(() => {
		if (!active) return;
		const id = window.setInterval(() => setBeat((b) => b + 1), BEAT_MS);
		return () => window.clearInterval(id);
	}, [active]);
	return beat;
}

type CellState = "on" | "off" | "dead" | "roll-done" | "roll-active";

interface PoolFrame {
	cells: CellState[];
	onCount: number;
	status: "scaling" | "steady" | "healing" | "rollout";
}

interface PoolDef {
	id: ProviderId;
	name: string;
	target: number;
	offset: number;
}

const POOLS: PoolDef[] = [
	{ id: "aws", name: "AWS", target: 6, offset: 0 },
	{ id: "gcp", name: "GCP", target: 4, offset: 7 },
	{ id: "azure", name: "Azure", target: 3, offset: 13 },
];

/** Derives one pool's cell states from the global beat (steady when reduced). */
function poolFrame(pool: PoolDef, beat: number, steady: boolean): PoolFrame {
	const { target } = pool;
	if (steady) {
		return {
			cells: Array.from({ length: target }, (): CellState => "on"),
			onCount: target,
			status: "steady",
		};
	}

	const low = Math.max(1, target - 2);
	const dead = target - 1;
	const t = mod(beat + pool.offset, CYCLE);

	let fill = target;
	let status: PoolFrame["status"] = "steady";
	let deadActive = false;
	let rollHead = -1;

	if (t <= 1) {
		fill = low + t;
		status = "scaling";
	} else if (t === 2) {
		status = "scaling";
	} else if (t <= 6) {
		status = "steady";
	} else if (t <= 8) {
		deadActive = true;
		status = "healing";
	} else if (t === 9) {
		status = "healing";
	} else if (t <= 11) {
		status = "steady";
	} else if (t <= 18) {
		rollHead = t - 12;
		status = "rollout";
	}

	const cells: CellState[] = [];
	for (let i = 0; i < target; i++) {
		if (deadActive && i === dead) cells.push("dead");
		else if (i >= fill) cells.push("off");
		else if (rollHead >= 0) {
			if (i < rollHead) cells.push("roll-done");
			else if (i === rollHead) cells.push("roll-active");
			else cells.push("on");
		} else cells.push("on");
	}

	const onCount = cells.filter((c) => c !== "off" && c !== "dead").length;
	return { cells, onCount, status };
}

type Posture = "in_sync" | "drifted" | "reconciling";

/** Cluster drift posture — mostly in_sync, detects drift, reconciles, re-proves. */
function posture(beat: number, steady: boolean): Posture {
	if (steady) return "in_sync";
	const t = mod(beat, 12);
	if (t === 9) return "drifted";
	if (t === 10) return "reconciling";
	return "in_sync";
}

const CELL_STEP = 21; // 18px cell + 3px gap

/** Grayscale style for a single fleet/drift capacity cell. */
function cellStyle(state: CellState, w: number, h: number): CSSProperties {
	const base: CSSProperties = {
		width: w,
		height: h,
		boxSizing: "border-box",
		border: "1px solid var(--border-strong)",
		borderRadius: "var(--radius-xs)",
		background: "transparent",
		transition:
			"background .5s cubic-bezier(.2,0,0,1), border-color .5s cubic-bezier(.2,0,0,1), opacity .45s, transform .45s cubic-bezier(.2,0,0,1), box-shadow .45s",
	};
	switch (state) {
		case "on":
			return { ...base, background: "var(--text-primary)", borderColor: "var(--text-primary)" };
		case "off":
			return { ...base, opacity: 0.42 };
		case "dead":
			return {
				...base,
				borderStyle: "dashed",
				borderColor: "var(--text-secondary)",
				opacity: 0.4,
				transform: "scale(.78)",
			};
		case "roll-done":
			return {
				...base,
				background: "var(--text-primary)",
				borderColor: "var(--text-primary)",
				boxShadow: "inset 0 0 0 2px var(--surface)",
			};
		case "roll-active":
			return {
				...base,
				background: "var(--text-primary)",
				borderColor: "var(--text-primary)",
				transform: "scale(1.2)",
				boxShadow: "0 0 0 3px color-mix(in oklch, var(--text-primary) 20%, transparent)",
			};
	}
}

/** One capacity cell (runner slot / cluster resource). */
function Cell({ state, w = 18, h = 10 }: { state: CellState; w?: number; h?: number }) {
	return <span style={cellStyle(state, w, h)} />;
}

const POOL_STATUS_LABEL: Record<PoolFrame["status"], string> = {
	scaling: "scaling",
	steady: "steady",
	healing: "healing",
	rollout: "rollout",
};

/** A single per-cloud warm-pool row: label · animated cells · state readout. */
function PoolRow({ pool, frame, last }: { pool: PoolDef; frame: PoolFrame; last: boolean }) {
	const rolling = frame.status === "rollout";
	const rollHead = frame.cells.indexOf("roll-active");
	return (
		<div
			style={{
				display: "flex",
				alignItems: "center",
				gap: 14,
				padding: "16px",
				borderBottom: last ? "none" : "1px solid var(--border-faint)",
			}}
		>
			<span
				style={{
					width: 66,
					display: "flex",
					alignItems: "center",
					gap: 7,
					...mono,
					fontSize: 11,
					color: "var(--text-secondary)",
					letterSpacing: "0.04em",
				}}
			>
				<Prov id={pool.id} size={13} />
				{pool.name}
			</span>

			<div style={{ position: "relative", display: "flex", gap: 3 }}>
				{frame.cells.map((c, k) => (
					<Cell key={k} state={c} />
				))}
				{/* rollout wave — a hairline sweeping across the cells */}
				<span
					aria-hidden
					style={{
						position: "absolute",
						top: -3,
						bottom: -3,
						left: (rollHead >= 0 ? rollHead : 0) * CELL_STEP + 9,
						width: 1,
						background:
							"linear-gradient(180deg, transparent, var(--text-primary), transparent)",
						opacity: rolling && rollHead >= 0 ? 0.8 : 0,
						transition: "left .45s cubic-bezier(.2,0,0,1), opacity .3s",
						pointerEvents: "none",
					}}
				/>
			</div>

			<span style={{ ...mono, fontSize: 11, color: "var(--text-tertiary)" }}>
				{frame.onCount}/{pool.target}
			</span>

			<span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 9 }}>
				<span
					style={{
						...mono,
						fontSize: 10,
						letterSpacing: "0.08em",
						textTransform: "uppercase",
						color:
							frame.status === "steady" ? "var(--text-tertiary)" : "var(--text-primary)",
						minWidth: 56,
						textAlign: "right",
						transition: "color .3s",
					}}
				>
					{POOL_STATUS_LABEL[frame.status]}
				</span>
				<span
					className={frame.status === "healing" ? "ah-pulse" : undefined}
					style={{
						width: 8,
						height: 8,
						borderRadius: 999,
						background:
							frame.status === "healing" ? "var(--text-primary)" : "var(--text-secondary)",
						boxShadow:
							frame.status === "rollout" ? "inset 0 0 0 2.5px var(--surface)" : "none",
						transition: "background .3s, box-shadow .3s",
					}}
				/>
			</span>
		</div>
	);
}

/** The runner fleet panel — warm pools that scale, self-heal, and roll. */
function FleetPanel({ beat, steady }: { beat: number; steady: boolean }) {
	const frames = POOLS.map((p) => poolFrame(p, beat, steady));
	const live = frames.reduce((n, f) => n + f.onCount, 0);
	const capacity = POOLS.reduce((n, p) => n + p.target, 0);

	return (
		<div
			style={{
				border: "1px solid var(--border)",
				borderRadius: "var(--radius-md)",
				overflow: "hidden",
				background: "var(--surface)",
				boxShadow: "var(--shadow-md)",
			}}
		>
			<div
				style={{
					display: "flex",
					alignItems: "center",
					gap: 10,
					padding: "13px 16px",
					borderBottom: "1px solid var(--border-faint)",
					background: "var(--surface-muted)",
				}}
			>
				<Icon k="server" size={15} />
				<span style={{ ...disp, fontSize: 13, fontWeight: 600, color: "var(--text-primary)" }}>
					Runner fleet
				</span>
				<span style={{ ...eyebrow, fontSize: 9 }}>warm pools</span>
				<span
					style={{
						marginLeft: "auto",
						...mono,
						fontSize: 11,
						color: "var(--text-secondary)",
					}}
				>
					<span style={{ color: "var(--text-primary)" }}>{live}</span>
					<span style={{ color: "var(--text-disabled)" }}> / {capacity} warm</span>
				</span>
			</div>
			{POOLS.map((p, i) => (
				<PoolRow key={p.id} pool={p} frame={frames[i]} last={i === POOLS.length - 1} />
			))}
		</div>
	);
}

const POSTURE_LABEL: Record<Posture, string> = {
	in_sync: "in_sync",
	drifted: "drifted",
	reconciling: "reconciling",
};

/** The drift posture badge — grayscale, state read through dot shape + label. */
function PostureBadge({ state }: { state: Posture }) {
	return (
		<span
			style={{
				display: "inline-flex",
				alignItems: "center",
				gap: 8,
				border: "1px solid var(--border-strong)",
				borderRadius: "var(--radius-sm)",
				padding: "4px 9px",
				background: "var(--surface-sunken)",
			}}
		>
			<span
				className={state === "reconciling" ? "ah-pulse" : undefined}
				style={{
					width: 8,
					height: 8,
					borderRadius: 999,
					background: state === "drifted" ? "transparent" : "var(--text-primary)",
					border: state === "drifted" ? "1.5px solid var(--text-secondary)" : "none",
					boxSizing: "border-box",
					transition: "background .3s, border-color .3s",
				}}
			/>
			<span
				style={{
					...mono,
					fontSize: 10.5,
					letterSpacing: "0.1em",
					textTransform: "uppercase",
					color: state === "in_sync" ? "var(--text-secondary)" : "var(--text-primary)",
					transition: "color .3s",
				}}
			>
				{POSTURE_LABEL[state]}
			</span>
		</span>
	);
}

const DRIFT_CELLS = 6;
const DRIFT_IDX = 3;

/** Live-row cell states for the drift reconciler at the current posture. */
function driftLive(state: Posture): CellState[] {
	return Array.from({ length: DRIFT_CELLS }, (_, i) => {
		if (i !== DRIFT_IDX) return "on";
		if (state === "drifted") return "off";
		if (state === "reconciling") return "roll-active";
		return "on";
	});
}

/** The drift reconciler panel — desired vs live, re-proven each cycle. */
function DriftPanel({ beat, steady }: { beat: number; steady: boolean }) {
	const state = posture(beat, steady);
	const desired: CellState[] = Array.from({ length: DRIFT_CELLS }, () => "on");
	const live = driftLive(state);

	return (
		<div
			style={{
				border: "1px solid var(--border)",
				borderRadius: "var(--radius-md)",
				overflow: "hidden",
				background: "var(--surface)",
				boxShadow: "var(--shadow-md)",
				display: "flex",
				flexDirection: "column",
			}}
		>
			<div
				style={{
					display: "flex",
					alignItems: "center",
					gap: 10,
					padding: "13px 16px",
					borderBottom: "1px solid var(--border-faint)",
					background: "var(--surface-muted)",
				}}
			>
				<Icon k="shield" size={15} />
				<span style={{ ...disp, fontSize: 13, fontWeight: 600, color: "var(--text-primary)" }}>
					Drift reconciler
				</span>
				<span style={{ marginLeft: "auto" }}>
					<PostureBadge state={state} />
				</span>
			</div>

			<div style={{ position: "relative", padding: "18px 16px", flex: 1 }}>
				{/* reconcile pulse sweep — only mounted while re-proving */}
				{state === "reconciling" ? (
					<span
						aria-hidden
						className="ah-shimmer"
						style={{
							position: "absolute",
							inset: 0,
							pointerEvents: "none",
						}}
					/>
				) : null}

				<div style={{ display: "flex", flexDirection: "column", gap: 16, position: "relative" }}>
					<div style={{ display: "flex", alignItems: "center", gap: 12 }}>
						<span
							style={{
								width: 90,
								...mono,
								fontSize: 10,
								letterSpacing: "0.08em",
								textTransform: "uppercase",
								color: "var(--text-tertiary)",
							}}
						>
							git · desired
						</span>
						<div style={{ display: "flex", gap: 4 }}>
							{desired.map((c, i) => (
								<Cell key={i} state={c} w={22} h={12} />
							))}
						</div>
					</div>

					<div style={{ display: "flex", alignItems: "center", gap: 12 }}>
						<span
							style={{
								width: 90,
								...mono,
								fontSize: 10,
								letterSpacing: "0.08em",
								textTransform: "uppercase",
								color: "var(--text-tertiary)",
							}}
						>
							cluster · live
						</span>
						<div style={{ display: "flex", gap: 4 }}>
							{live.map((c, i) => (
								<Cell key={i} state={c} w={22} h={12} />
							))}
						</div>
					</div>
				</div>

				<p
					style={{
						...mono,
						fontSize: 10.5,
						letterSpacing: "0.02em",
						color: "var(--text-tertiary)",
						margin: "20px 0 0",
						position: "relative",
					}}
				>
					reconciles cluster to Git · re-proven every cycle
				</p>
			</div>
		</div>
	);
}

const POINT_ICONS: IconKey[] = ["gauge", "shield", "route"];

/**
 * Fleet — homepage section 06 "Operate". A self-healing runner fleet that
 * scales to demand, replaces dead nodes and rolls itself, beside a drift
 * reconciler that keeps re-proving the cluster (in_sync vs drifted). The whole
 * scene is a continuous, in-view-gated loop with a steady reduced-motion frame.
 */
export function Fleet() {
	const ref = useRef<HTMLDivElement>(null);
	const inView = useInView(ref, { amount: 0.3 });
	const reduced = usePrefersReducedMotion();
	const beat = useBeat(inView && !reduced);
	const steady = reduced;

	return (
		<SectionShell n={STORY.fleet.n} label={STORY.fleet.label} title={STORY.fleet.title}>
			<Reveal>
				<p
					style={{
						fontSize: 15.5,
						lineHeight: 1.6,
						color: "var(--text-secondary)",
						margin: "0 0 40px",
						maxWidth: 660,
					}}
				>
					{STORY.fleet.line}
				</p>
			</Reveal>

			<div
				ref={ref}
				style={{
					display: "flex",
					flexWrap: "wrap",
					gap: 20,
					alignItems: "stretch",
				}}
			>
				<Reveal style={{ flex: "1 1 380px", display: "flex" }}>
					<div style={{ width: "100%" }}>
						<FleetPanel beat={beat} steady={steady} />
					</div>
				</Reveal>
				<Reveal delay={0.08} style={{ flex: "1 1 320px", display: "flex" }}>
					<div style={{ width: "100%", display: "flex" }}>
						<DriftPanel beat={beat} steady={steady} />
					</div>
				</Reveal>
			</div>

			<div
				style={{
					display: "flex",
					flexWrap: "wrap",
					gap: 12,
					marginTop: 20,
				}}
			>
				{STORY.fleet.points.map((pt, i) => (
					<Reveal key={pt} delay={stagger(i)} style={{ flex: "1 1 220px", display: "flex" }}>
						<div
							style={{
								display: "flex",
								alignItems: "center",
								gap: 12,
								width: "100%",
								border: "1px solid var(--border)",
								borderRadius: "var(--radius-md)",
								padding: "14px 16px",
								background: "var(--surface)",
							}}
						>
							<span
								style={{
									display: "grid",
									placeItems: "center",
									width: 30,
									height: 30,
									flexShrink: 0,
									borderRadius: "var(--radius-sm)",
									border: "1px solid var(--border)",
									background: "var(--surface-sunken)",
									color: "var(--text-primary)",
								}}
							>
								<Icon k={POINT_ICONS[i] ?? "gauge"} size={15} />
							</span>
							<span
								style={{ fontSize: 13, fontWeight: 500, color: "var(--text-primary)" }}
							>
								{pt}
							</span>
						</div>
					</Reveal>
				))}
			</div>
		</SectionShell>
	);
}
