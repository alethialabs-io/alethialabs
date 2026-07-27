// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

"use client";

import { type CSSProperties, type ReactNode, useRef } from "react";
import { type Transition, motion, useInView } from "motion/react";
import { STORY } from "../motion/storyboard";
import { SectionShell } from "../motion/section-shell";
import { Reveal } from "../motion/reveal";
import { ScanLine } from "../motion/scan-line";
import { usePrefersReducedMotion } from "../motion/use-reduced-motion";
import { Icon, mono, eyebrow, Prov, type ProviderId } from "../primitives";

/* ---------- static structure (not copy — structural column/row labels) ---------- */

/** Capability columns; the second entry is the special per-cloud identity column. */
const CAPS: readonly string[] = ["Cluster", "Workload identity", "Keyless", "GitOps", "Drift"];
const IDENTITY_COL = 1;

/** Human display names for the cloud row headers. */
const CLOUD_NAME: Record<string, string> = {
	aws: "AWS",
	gcp: "GCP",
	azure: "Azure",
	hetzner: "Hetzner",
	alibaba: "Alibaba",
};

const GRID = "minmax(132px, 0.95fr) 92px minmax(178px, 1.35fr) 92px 92px 92px";

const spring: Transition = { type: "spring", stiffness: 260, damping: 26, mass: 0.85 };

/** True when a cloud id has a first-party grayscale provider logo. */
function hasProvLogo(id: string): id is ProviderId {
	return id === "aws" || id === "gcp" || id === "azure";
}

/** Alignment a capability column uses (the identity column is left-read). */
function capAlign(col: number): "left" | "center" {
	return col === IDENTITY_COL ? "left" : "center";
}

/* ---------- the animated cell ---------- */

/**
 * One matrix cell whose grayscale fill sweeps in from the left and whose mark
 * settles a beat later — the diagonal wave is driven by `delay`. Under reduced
 * motion it renders in its final filled state with no transform.
 */
function Cell({
	active,
	reduced,
	delay,
	align,
	fill,
	lastCol,
	lastRow,
	children,
}: {
	active: boolean;
	reduced: boolean;
	delay: number;
	align: "left" | "center";
	fill: boolean;
	lastCol: boolean;
	lastRow: boolean;
	children: ReactNode;
}) {
	const base: CSSProperties = {
		position: "relative",
		minHeight: 56,
		display: "flex",
		alignItems: "center",
		justifyContent: align === "center" ? "center" : "flex-start",
		padding: align === "center" ? "0 12px" : "0 16px",
		overflow: "hidden",
		borderRight: lastCol ? "none" : "1px solid var(--border-faint)",
		borderBottom: lastRow ? "none" : "1px solid var(--border-faint)",
	};
	const content: CSSProperties = {
		position: "relative",
		zIndex: 1,
		display: "flex",
		alignItems: "center",
		gap: 8,
	};

	if (reduced) {
		return (
			<div style={base}>
				{fill ? (
					<span aria-hidden style={{ position: "absolute", inset: 0, background: "var(--surface-muted)" }} />
				) : null}
				<span style={content}>{children}</span>
			</div>
		);
	}

	return (
		<div style={base}>
			{fill ? (
				<motion.span
					aria-hidden
					style={{ position: "absolute", inset: 0, background: "var(--surface-muted)", transformOrigin: "left center" }}
					initial={{ scaleX: 0 }}
					animate={active ? { scaleX: 1 } : { scaleX: 0 }}
					transition={{ ...spring, delay }}
				/>
			) : null}
			<motion.span
				style={content}
				initial={{ opacity: 0, y: 6 }}
				animate={active ? { opacity: 1, y: 0 } : { opacity: 0, y: 6 }}
				transition={{ ...spring, delay: delay + 0.07 }}
			>
				{children}
			</motion.span>
		</div>
	);
}

/* ---------- cell contents ---------- */

/** A filled, bordered check tile — the "supported" mark shared by every check column. */
function CheckTile() {
	return (
		<span
			style={{
				display: "grid",
				placeItems: "center",
				width: 22,
				height: 22,
				borderRadius: "var(--radius-sm)",
				border: "1px solid var(--border-strong)",
				background: "var(--surface-raised)",
				color: "var(--text-primary)",
				boxShadow: "var(--shadow-md)",
			}}
		>
			<Icon k="check" size={13} sw={2.4} />
		</span>
	);
}

/** The per-cloud workload-identity value, rendered as a mono chip. */
function IdentityChip({ value }: { value: string }) {
	return (
		<span
			style={{
				display: "inline-flex",
				alignItems: "center",
				gap: 8,
				maxWidth: "100%",
				padding: "5px 10px",
				border: "1px solid var(--border-strong)",
				borderRadius: "var(--radius-sm)",
				background: "var(--surface-raised)",
				...mono,
				fontSize: 11.5,
				letterSpacing: "0.01em",
				color: "var(--text-primary)",
				whiteSpace: "nowrap",
			}}
		>
			<span style={{ width: 4, height: 4, background: "var(--text-primary)", flexShrink: 0 }} />
			{value}
		</span>
	);
}

/** The cloud row header — grayscale provider logo, or a mono text mark. */
function CloudMark({ id }: { id: string }) {
	const name = CLOUD_NAME[id] ?? id;
	return (
		<span style={{ display: "flex", alignItems: "center", gap: 11 }}>
			<span style={{ display: "grid", placeItems: "center", width: 26, height: 26, flexShrink: 0 }}>
				{hasProvLogo(id) ? (
					<Prov id={id} size={20} />
				) : (
					<span
						style={{
							display: "grid",
							placeItems: "center",
							width: 24,
							height: 24,
							border: "1px solid var(--border-strong)",
							borderRadius: "var(--radius-sm)",
							...mono,
							fontSize: 11,
							fontWeight: 600,
							color: "var(--text-secondary)",
						}}
					>
						{name.slice(0, 2).toUpperCase()}
					</span>
				)}
			</span>
			<span style={{ fontSize: 13.5, fontWeight: 500, letterSpacing: "-0.01em", color: "var(--text-primary)" }}>
				{name}
			</span>
		</span>
	);
}

/* ---------- header row ---------- */

/** The column-header band above the matrix (corner label + capability labels). */
function HeaderRow() {
	return (
		<>
			<div
				style={{
					display: "flex",
					alignItems: "center",
					padding: "0 16px",
					minHeight: 44,
					borderRight: "1px solid var(--border-faint)",
					borderBottom: "1px solid var(--border)",
					background: "var(--surface-sunken)",
				}}
			>
				<span style={{ ...eyebrow, fontSize: 9 }}>Cloud</span>
			</div>
			{CAPS.map((cap, i) => {
				const align = capAlign(i);
				return (
					<div
						key={cap}
						style={{
							display: "flex",
							alignItems: "center",
							justifyContent: align === "center" ? "center" : "flex-start",
							padding: align === "center" ? "0 10px" : "0 16px",
							minHeight: 44,
							borderRight: i < CAPS.length - 1 ? "1px solid var(--border-faint)" : "none",
							borderBottom: "1px solid var(--border)",
							background: "var(--surface-sunken)",
						}}
					>
						<span style={{ ...eyebrow, fontSize: 9, textAlign: align === "center" ? "center" : "left", lineHeight: 1.3 }}>
							{cap}
						</span>
					</div>
				);
			})}
		</>
	);
}

/* ---------- section ---------- */

/**
 * Section 05 — the multi-cloud parity matrix: every cloud (rows) satisfies every
 * capability (columns), with the workload-identity mechanism rendered per cloud.
 * Cells fill in on a staggered diagonal wave when the matrix scrolls into view;
 * under reduced motion the matrix is shown fully filled.
 */
export function ParityMatrix() {
	const copy = STORY.parity;
	const clouds = copy.clouds;
	const gridRef = useRef<HTMLDivElement>(null);
	const inView = useInView(gridRef, { once: true, amount: 0.25 });
	const reduced = usePrefersReducedMotion();
	const active = reduced || inView;

	return (
		<SectionShell n={copy.n} label={copy.label} title={copy.title}>
			<Reveal>
				<p
					style={{
						fontSize: 15,
						lineHeight: 1.6,
						color: "var(--text-secondary)",
						margin: "0 0 34px",
						maxWidth: 620,
					}}
				>
					{copy.line}
				</p>
			</Reveal>

			<Reveal delay={0.05} y={22}>
				<div style={{ overflowX: "auto" }}>
					<div
						ref={gridRef}
						style={{
							position: "relative",
							minWidth: 700,
							border: "1px solid var(--border)",
							borderRadius: "var(--radius-md)",
							background: "var(--surface)",
							boxShadow: "var(--shadow-lg)",
							overflow: "hidden",
						}}
					>
						<ScanLine duration={3.2} />
						<div style={{ display: "grid", gridTemplateColumns: GRID }}>
							<HeaderRow />

							{clouds.map(([id, identity], row) => {
								const lastRow = row === clouds.length - 1;
								return (
									<div key={id} style={{ display: "contents" }}>
										{/* cloud row header */}
										<Cell
											active={active}
											reduced={reduced}
											delay={row * 0.05 + 0.02}
											align="left"
											fill={false}
											lastCol={false}
											lastRow={lastRow}
										>
											<CloudMark id={id} />
										</Cell>

										{/* capability cells */}
										{CAPS.map((cap, col) => {
											const align = capAlign(col);
											const delay = (row + col + 1) * 0.05 + 0.05;
											return (
												<Cell
													key={cap}
													active={active}
													reduced={reduced}
													delay={delay}
													align={align}
													fill
													lastCol={col === CAPS.length - 1}
													lastRow={lastRow}
												>
													{col === IDENTITY_COL ? <IdentityChip value={identity} /> : <CheckTile />}
												</Cell>
											);
										})}
									</div>
								);
							})}
						</div>

						{/* ledger footer — structural counts, not a claim */}
						<div
							style={{
								display: "flex",
								flexWrap: "wrap",
								alignItems: "center",
								gap: "6px 20px",
								padding: "13px 18px",
								borderTop: "1px solid var(--border)",
								background: "var(--surface-sunken)",
								...mono,
								fontSize: 11,
								letterSpacing: "0.04em",
								color: "var(--text-tertiary)",
							}}
						>
							<span>
								<span style={{ color: "var(--text-secondary)" }}>{clouds.length}</span> clouds
							</span>
							<span>
								<span style={{ color: "var(--text-secondary)" }}>{CAPS.length}</span> capabilities
							</span>
							<span>workload identity rendered automatically</span>
							<span style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 8 }}>
								<span style={{ width: 4, height: 4, background: "var(--text-primary)" }} />
								one project
								<Icon k="arrow" size={12} sw={2} />
								every cloud
							</span>
						</div>
					</div>
				</div>
			</Reveal>
		</SectionShell>
	);
}
