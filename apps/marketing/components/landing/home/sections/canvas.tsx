// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { type CSSProperties, useRef, useState } from "react";
import { motion, useInView } from "motion/react";
import { Badge } from "@repo/ui/badge";
import { STORY } from "@/components/landing/home/motion/storyboard";
import { SectionShell } from "@/components/landing/home/motion/section-shell";
import { Reveal, stagger } from "@/components/landing/home/motion/reveal";
import { CountUp } from "@/components/landing/home/motion/count-up";
import { usePrefersReducedMotion } from "@/components/landing/home/motion/use-reduced-motion";
import {
	disp,
	eyebrow,
	Icon,
	type IconKey,
	mono,
} from "@/components/landing/home/primitives";

const C = STORY.canvas;

/* ---------- graph model ---------- */
/** A node on the architecture canvas: its place in the 100×66 graph space and its config. */
interface GNode {
	id: string;
	label: string;
	sub: string;
	icon: IconKey;
	/** x in the 0–100 graph space. */
	x: number;
	/** y in the 0–66 graph space. */
	y: number;
	/** In VPC = enclosed by the VPC boundary; the ingress node sits outside it. */
	inVpc: boolean;
	config: [string, string][];
}

const NET: GNode = {
	id: "network",
	label: "Network",
	sub: "vpc · 3 subnets",
	icon: "layers",
	x: 13,
	y: 33,
	inVpc: false,
	config: [
		["cidr", "10.0.0.0/16"],
		["subnets", "3 private"],
		["nat gateway", "single"],
		["region", "eu-central-1"],
	],
};

const CLUSTER: GNode = {
	id: "cluster",
	label: "Cluster",
	sub: "k8s · 3 nodes",
	icon: "grid",
	x: 45,
	y: 33,
	inVpc: true,
	config: [
		["version", "1.30"],
		["nodes", "3 × m6i.large"],
		["autoscale", "3 – 9"],
		["identity", "IRSA · keyless"],
	],
};

const DB: GNode = {
	id: "database",
	label: "Database",
	sub: "postgres 16",
	icon: "server",
	x: 82,
	y: 13,
	inVpc: true,
	config: [
		["engine", "postgres 16"],
		["instance", "db.r6g.large"],
		["storage", "100 GiB gp3"],
		["multi-az", "yes"],
		["public", "no"],
		["encrypted", "yes"],
	],
};

const CACHE: GNode = {
	id: "cache",
	label: "Cache",
	sub: "redis 7.1",
	icon: "zap",
	x: 82,
	y: 33,
	inVpc: true,
	config: [
		["engine", "redis 7.1"],
		["node", "cache.r6g.large"],
		["replicas", "2"],
		["encrypted", "yes"],
	],
};

const DNS: GNode = {
	id: "dns",
	label: "DNS",
	sub: "route 53",
	icon: "route",
	x: 82,
	y: 53,
	inVpc: false,
	config: [
		["zone", "api.acme.io"],
		["records", "4"],
		["provider", "route 53"],
		["ttl", "300s"],
	],
};

const NODES: GNode[] = [NET, CLUSTER, DB, CACHE, DNS];

/** An edge in the 100×66 graph space; `target` names the node it lands on (null = trunk). */
interface GEdge {
	d: string;
	target: string | null;
}

const EDGES: GEdge[] = [
	{ d: "M13 33 H45", target: null },
	{ d: "M45 33 H63 V13 H82", target: "database" },
	{ d: "M45 33 H82", target: "cache" },
	{ d: "M45 33 H63 V53 H82", target: "dns" },
];

/** Map a node's 0–66 y into a top-percentage of the graph area. */
function topPct(y: number): number {
	return (y / 66) * 100;
}

/* ---------- node card ---------- */
/** A bordered, selectable resource node on the canvas. */
function NodeCard({
	node,
	selected,
	onSelect,
}: {
	node: GNode;
	selected: boolean;
	onSelect: (id: string) => void;
}) {
	return (
		<button
			type="button"
			onClick={() => onSelect(node.id)}
			aria-pressed={selected}
			style={{
				display: "flex",
				flexDirection: "column",
				gap: 7,
				alignItems: "flex-start",
				width: 116,
				padding: "11px 12px",
				textAlign: "left",
				cursor: "pointer",
				border: `1px solid ${selected ? "var(--text-primary)" : "var(--border-strong)"}`,
				borderRadius: "var(--radius-md)",
				background: selected ? "var(--surface-raised)" : "var(--surface)",
				boxShadow: selected ? "var(--shadow-md)" : "none",
				color: "var(--text-primary)",
				transition:
					"border-color .18s ease, box-shadow .18s ease, background .18s ease",
			}}
		>
			<span style={{ display: "flex", alignItems: "center", gap: 8, width: "100%" }}>
				<span
					style={{
						display: "grid",
						placeItems: "center",
						width: 26,
						height: 26,
						flexShrink: 0,
						border: "1px solid var(--border)",
						borderRadius: "var(--radius-sm)",
						background: "var(--surface-sunken)",
						color: "var(--text-primary)",
					}}
				>
					<Icon k={node.icon} size={14} />
				</span>
				<span
					aria-hidden
					style={{
						marginLeft: "auto",
						width: 6,
						height: 6,
						borderRadius: 999,
						background: selected ? "var(--text-primary)" : "var(--border-strong)",
						transition: "background .18s ease",
					}}
				/>
			</span>
			<span style={{ ...disp, fontSize: 13, fontWeight: 600, lineHeight: 1 }}>
				{node.label}
			</span>
			<span
				style={{
					...mono,
					fontSize: 10,
					color: "var(--text-tertiary)",
					letterSpacing: "0.02em",
				}}
			>
				{node.sub}
			</span>
		</button>
	);
}

/* ---------- inspector ---------- */
const inspectorStrip: CSSProperties = {
	borderTop: "1px solid var(--border)",
	background: "var(--surface-sunken)",
	padding: "16px 18px",
	overflow: "hidden",
};

/** The node inspector: config for the currently-selected node, sliding in on change. */
function Inspector({ node }: { node: GNode }) {
	const reduced = usePrefersReducedMotion();
	return (
		<Reveal delay={0.15} style={inspectorStrip}>
			<motion.div
				key={node.id}
				initial={reduced ? false : { opacity: 0, x: 24 }}
				animate={{ opacity: 1, x: 0 }}
				transition={{ type: "spring", stiffness: 260, damping: 30, mass: 0.8 }}
			>
				<div
					style={{
						display: "flex",
						alignItems: "center",
						gap: 10,
						marginBottom: 14,
					}}
				>
					<span
						style={{
							display: "grid",
							placeItems: "center",
							width: 28,
							height: 28,
							border: "1px solid var(--border-strong)",
							borderRadius: "var(--radius-sm)",
							background: "var(--surface-raised)",
							color: "var(--text-primary)",
						}}
					>
						<Icon k={node.icon} size={15} />
					</span>
					<span style={{ ...disp, fontSize: 14, fontWeight: 600, color: "var(--text-primary)" }}>
						{node.label}
					</span>
					<span
						style={{
							...mono,
							fontSize: 10,
							color: "var(--text-tertiary)",
							letterSpacing: "0.02em",
						}}
					>
						{node.sub}
					</span>
					<span style={{ ...eyebrow, fontSize: 9, marginLeft: "auto" }}>
						Node inspector
					</span>
				</div>
				<div
					style={{
						display: "grid",
						gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
						gap: "1px",
						background: "var(--border-faint)",
						border: "1px solid var(--border-faint)",
						borderRadius: "var(--radius-sm)",
						overflow: "hidden",
					}}
				>
					{node.config.map(([k, v]) => (
						<div
							key={k}
							style={{
								display: "flex",
								alignItems: "baseline",
								justifyContent: "space-between",
								gap: 10,
								padding: "9px 12px",
								background: "var(--surface)",
							}}
						>
							<span
								style={{
									...mono,
									fontSize: 10.5,
									color: "var(--text-tertiary)",
									letterSpacing: "0.02em",
								}}
							>
								{k}
							</span>
							<span
								style={{
									...mono,
									fontSize: 11.5,
									color: "var(--text-primary)",
									textAlign: "right",
								}}
							>
								{v}
							</span>
						</div>
					))}
				</div>
			</motion.div>
		</Reveal>
	);
}

/* ---------- edge ---------- */
/** A single graph edge that strokes itself in (pathLength) once the graph is in view. */
function Edge({
	edge,
	index,
	inView,
	active,
	reduced,
}: {
	edge: GEdge;
	index: number;
	inView: boolean;
	active: boolean;
	reduced: boolean;
}) {
	const rest = reduced ? 1 : 0;
	return (
		<motion.path
			d={edge.d}
			fill="none"
			stroke={active ? "var(--text-primary)" : "var(--border-strong)"}
			strokeWidth={1}
			strokeLinecap="round"
			strokeLinejoin="round"
			vectorEffect="non-scaling-stroke"
			style={{ transition: "stroke .2s ease" }}
			initial={{ pathLength: rest, opacity: rest }}
			animate={inView ? { pathLength: 1, opacity: 1 } : { pathLength: rest, opacity: rest }}
			transition={{ duration: 0.9, delay: 0.3 + index * 0.12, ease: [0.16, 1, 0.3, 1] }}
		/>
	);
}

/* ---------- section ---------- */
/** Section 03 "Design": a self-drawing architecture graph with a live node inspector and cost. */
export function CanvasSection() {
	const [selected, setSelected] = useState<string>("database");
	const graphRef = useRef<HTMLDivElement>(null);
	const inView = useInView(graphRef, { once: true, amount: 0.3 });
	const reduced = usePrefersReducedMotion();

	const sel = NODES.find((n) => n.id === selected) ?? DB;

	return (
		<SectionShell n={C.n} label={C.label} title={C.title}>
			<div
				style={{
					display: "flex",
					flexWrap: "wrap",
					gap: 36,
					alignItems: "flex-start",
				}}
			>
				{/* ---- narrative aside ---- */}
				<aside style={{ flex: "1 1 250px", minWidth: 0, maxWidth: 360 }}>
					<Reveal>
						<p
							style={{
								fontSize: 15,
								lineHeight: 1.62,
								color: "var(--text-secondary)",
								margin: "0 0 26px",
							}}
						>
							{C.line}
						</p>
					</Reveal>

					<div role="list" style={{ margin: "0 0 28px" }}>
						{C.points.map((point, i) => (
							<Reveal key={point} delay={stagger(i)}>
								<div
									role="listitem"
									style={{
										display: "flex",
										alignItems: "center",
										gap: 12,
										padding: "11px 0",
										borderTop: i === 0 ? "none" : "1px solid var(--border-faint)",
									}}
								>
									<span
										aria-hidden
										style={{
											width: 7,
											height: 7,
											flexShrink: 0,
											border: "1px solid var(--text-primary)",
											borderRadius: "var(--radius-xs)",
										}}
									/>
									<span style={{ fontSize: 13.5, color: "var(--text-primary)" }}>
										{point}
									</span>
								</div>
							</Reveal>
						))}
					</div>

					{/* live cost readout */}
					<Reveal delay={0.1}>
						<div
							style={{
								border: "1px solid var(--border)",
								borderRadius: "var(--radius-md)",
								background: "var(--surface-raised)",
								boxShadow: "var(--shadow-md)",
								padding: "16px 18px",
							}}
						>
							<span
								style={{
									...eyebrow,
									fontSize: 9,
									display: "flex",
									alignItems: "center",
									gap: 8,
								}}
							>
								<span className="ah-pulse" />
								Live estimate · Infracost
							</span>
							<div
								style={{
									display: "flex",
									alignItems: "baseline",
									gap: 4,
									margin: "12px 0 6px",
								}}
							>
								<CountUp
									value={Number(C.cost)}
									prefix="$"
									decimals={2}
									style={{
										...mono,
										fontSize: 34,
										lineHeight: 1,
										fontWeight: 500,
										letterSpacing: "-0.02em",
										color: "var(--text-primary)",
										fontVariantNumeric: "tabular-nums",
									}}
								/>
								<span
									style={{
										...mono,
										fontSize: 14,
										color: "var(--text-tertiary)",
									}}
								>
									/mo
								</span>
							</div>
							<span
								style={{
									...mono,
									fontSize: 10.5,
									color: "var(--text-tertiary)",
									letterSpacing: "0.02em",
								}}
							>
								estimated · recomputed as you shape the canvas
							</span>
						</div>
					</Reveal>
				</aside>

				{/* ---- the canvas graph ---- */}
				<div style={{ flex: "2 1 480px", minWidth: 0 }}>
					<div
						style={{
							border: "1px solid var(--border)",
							borderRadius: "var(--radius-md)",
							background: "var(--surface)",
							boxShadow: "var(--shadow-md)",
							overflow: "hidden",
						}}
					>
						{/* card header */}
						<div
							style={{
								display: "flex",
								alignItems: "center",
								gap: 12,
								padding: "12px 16px",
								borderBottom: "1px solid var(--border)",
								background: "var(--surface-muted)",
							}}
						>
							<span style={{ display: "flex", gap: 6 }}>
								{[0, 1, 2].map((i) => (
									<span
										key={i}
										style={{
											width: 9,
											height: 9,
											borderRadius: 999,
											border: "1px solid var(--border-strong)",
										}}
									/>
								))}
							</span>
							<span style={{ ...mono, fontSize: 12, color: "var(--text-secondary)" }}>
								canvas · <span style={{ color: "var(--text-tertiary)" }}>orders-api</span>
							</span>
							<span
								style={{
									marginLeft: "auto",
									display: "flex",
									alignItems: "center",
									gap: 10,
								}}
							>
								<span
									style={{
										...mono,
										fontSize: 10.5,
										color: "var(--text-tertiary)",
									}}
								>
									{NODES.length} resources
								</span>
								<Badge
									variant="outline"
									className="rounded-none text-[9px] uppercase tracking-widest"
								>
									keyless
								</Badge>
							</span>
						</div>

						{/* graph area (scrolls horizontally on very narrow viewports) */}
						<div style={{ overflowX: "auto" }}>
							<div
								ref={graphRef}
								style={{
									position: "relative",
									height: 344,
									minWidth: 460,
								}}
							>
								{/* blueprint grid backdrop */}
								<span aria-hidden className="ah-grid-bg" style={{ zIndex: 0 }} />

								{/* VPC boundary */}
								<div
									aria-hidden
									style={{
										position: "absolute",
										left: "30%",
										top: "7%",
										width: "67%",
										height: "86%",
										border: "1px dashed var(--border-strong)",
										borderRadius: "var(--radius-sm)",
										zIndex: 0,
									}}
								>
									<span
										style={{
											position: "absolute",
											top: -9,
											left: 12,
											padding: "0 7px",
											background: "var(--surface)",
											...mono,
											fontSize: 9.5,
											letterSpacing: "0.14em",
											textTransform: "uppercase",
											color: "var(--text-tertiary)",
										}}
									>
										vpc · eu-central-1
									</span>
								</div>

								{/* edges */}
								<svg
									viewBox="0 0 100 66"
									preserveAspectRatio="none"
									style={{
										position: "absolute",
										inset: 0,
										width: "100%",
										height: "100%",
										overflow: "visible",
										zIndex: 1,
									}}
								>
									{EDGES.map((edge, i) => (
										<Edge
											key={i}
											edge={edge}
											index={i}
											inView={inView}
											active={edge.target !== null && edge.target === selected}
											reduced={reduced}
										/>
									))}
									<circle
										cx={63}
										cy={33}
										r={0.9}
										fill="var(--border-strong)"
									/>
								</svg>

								{/* nodes */}
								{NODES.map((node, i) => (
									<div
										key={node.id}
										style={{
											position: "absolute",
											left: `${node.x}%`,
											top: `${topPct(node.y)}%`,
											transform: "translate(-50%, -50%)",
											zIndex: 2,
										}}
									>
										<Reveal delay={0.5 + stagger(i)}>
											<NodeCard
												node={node}
												selected={node.id === selected}
												onSelect={setSelected}
											/>
										</Reveal>
									</div>
								))}
							</div>
						</div>

						{/* inspector */}
						<Inspector node={sel} />
					</div>
				</div>
			</div>
		</SectionShell>
	);
}
