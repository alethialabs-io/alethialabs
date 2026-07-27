// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

"use client";

import {
	type CSSProperties,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { motion, useInView } from "motion/react";
import { Button } from "@repo/ui/button";
import { STORY } from "@/components/landing/home/motion/storyboard";
import { SectionShell } from "@/components/landing/home/motion/section-shell";
import { Reveal } from "@/components/landing/home/motion/reveal";
import { Stamp } from "@/components/landing/home/motion/stamp";
import { ScanLine } from "@/components/landing/home/motion/scan-line";
import { usePrefersReducedMotion } from "@/components/landing/home/motion/use-reduced-motion";
import { eyebrow, Icon, Mark, mono } from "@/components/landing/home/primitives";
import { VerifyReceipt } from "@/components/landing/home/verify-receipt";
import { SAMPLE_RECEIPT } from "@/lib/proof/verify-receipt-sample";

/** The three states of the fail-closed gate: waiting, sweeping controls, verdict issued. */
type Phase = "idle" | "running" | "done";

const V = STORY.verify;
const PLAN = SAMPLE_RECEIPT.receipt;
// Drive the gate from the SAME signed evidence the issued receipt renders, so the
// animated rows, the verdict count, and the downloadable receipt.json never assert
// more than the receipt proves — exactly the controls this plan was signed over.
const CONTROLS = PLAN.report.controls;
const N = CONTROLS.length;

/* ---------- style tokens (annotated so `textTransform` etc. don't widen) ---------- */
const gateCard: CSSProperties = {
	position: "relative",
	overflow: "hidden",
	width: "100%",
	maxWidth: 760,
	border: "1px solid var(--border-strong)",
	borderRadius: "var(--radius-md)",
	background: "var(--surface)",
	boxShadow: "var(--shadow-lg)",
};

const toolbar: CSSProperties = {
	display: "flex",
	alignItems: "center",
	gap: 12,
	flexWrap: "wrap",
	padding: "13px 16px",
	borderBottom: "1px solid var(--border)",
	background: "var(--surface-muted)",
};

const toolMono: CSSProperties = {
	...mono,
	fontSize: 12,
	color: "var(--text-secondary)",
};

const tagChip: CSSProperties = {
	...mono,
	fontSize: 9,
	letterSpacing: "0.14em",
	textTransform: "uppercase",
	color: "var(--text-tertiary)",
	border: "1px solid var(--border-strong)",
	borderRadius: "var(--radius-xs)",
	padding: "2px 7px",
};

const planRow: CSSProperties = {
	display: "flex",
	alignItems: "center",
	gap: 8,
	flexWrap: "wrap",
	padding: "12px 16px",
	borderBottom: "1px solid var(--border-faint)",
	...mono,
	fontSize: 11,
	color: "var(--text-tertiary)",
};

const rowBase: CSSProperties = {
	display: "flex",
	alignItems: "center",
	gap: 13,
	padding: "12px 16px 12px 14px",
	borderBottom: "1px solid var(--border-faint)",
};

const boxOn: CSSProperties = {
	width: 18,
	height: 18,
	display: "grid",
	placeItems: "center",
	flexShrink: 0,
	border: "1px solid var(--text-primary)",
	background: "var(--text-primary)",
	color: "var(--background)",
	borderRadius: "var(--radius-sm)",
};

const boxOff: CSSProperties = {
	width: 18,
	height: 18,
	display: "grid",
	placeItems: "center",
	flexShrink: 0,
	border: "1px solid var(--border-strong)",
	background: "transparent",
	color: "transparent",
	borderRadius: "var(--radius-sm)",
};

const checkWrap: CSSProperties = { display: "flex", lineHeight: 0 };

const statusText: CSSProperties = {
	...mono,
	fontSize: 9.5,
	letterSpacing: "0.14em",
	textTransform: "uppercase",
	marginLeft: "auto",
	whiteSpace: "nowrap",
};

const verdictBar: CSSProperties = {
	display: "flex",
	alignItems: "center",
	gap: 12,
	flexWrap: "wrap",
	padding: "14px 16px",
	background: "var(--surface-sunken)",
};

const seal: CSSProperties = {
	display: "inline-flex",
	alignItems: "center",
	gap: 9,
	padding: "6px 12px",
	border: "1px solid var(--text-primary)",
	borderRadius: "var(--radius-sm)",
	color: "var(--text-primary)",
	boxShadow: "inset 0 0 0 3px var(--surface)",
};

const sealLabel: CSSProperties = {
	...mono,
	fontSize: 10,
	letterSpacing: "0.2em",
	textTransform: "uppercase",
	fontWeight: 600,
};

/** A single grayscale status pill for the toolbar (idle / verifying / passed). */
function StatusPill({ phase }: { phase: Phase }) {
	const label = phase === "done" ? "passed" : phase === "running" ? "verifying" : "idle";
	return (
		<span
			style={{
				display: "inline-flex",
				alignItems: "center",
				gap: 7,
				...mono,
				fontSize: 9.5,
				letterSpacing: "0.16em",
				textTransform: "uppercase",
				color: phase === "idle" ? "var(--text-disabled)" : "var(--text-secondary)",
			}}
		>
			<span
				className={phase === "running" ? "ah-pulse" : undefined}
				style={{
					width: 7,
					height: 7,
					borderRadius: 999,
					background: phase === "idle" ? "var(--border-strong)" : "var(--text-primary)",
				}}
			/>
			{label}
		</span>
	);
}

/**
 * Section 04 — the interactive verification differentiator. A visitor runs the
 * fail-closed gate: a scan line sweeps the plan, the controls check off one by
 * one, then a genuine signed ed25519 receipt is issued and can be downloaded
 * (it verifies offline). Auto-plays once on scroll-in and is re-triggerable;
 * under reduced motion every control is already passed and the receipt present.
 */
export function VerifyGate() {
	const reduced = usePrefersReducedMotion();
	const rootRef = useRef<HTMLDivElement>(null);
	const inView = useInView(rootRef, { once: true, amount: 0.4 });
	const timers = useRef<number[]>([]);
	const [phase, setPhase] = useState<Phase>("idle");
	const [passed, setPassed] = useState(0);

	const clearTimers = useCallback(() => {
		for (const t of timers.current) clearTimeout(t);
		timers.current = [];
	}, []);

	/** Play the gate sequence; under reduced motion it settles instantly to the verdict. */
	const run = useCallback(() => {
		clearTimers();
		if (reduced) {
			setPassed(N);
			setPhase("done");
			return;
		}
		setPhase("running");
		setPassed(0);
		const base = 520;
		const step = 440;
		for (let i = 0; i < N; i++) {
			timers.current.push(
				window.setTimeout(() => setPassed(i + 1), base + i * step),
			);
		}
		timers.current.push(
			window.setTimeout(() => setPhase("done"), base + N * step + 360),
		);
	}, [clearTimers, reduced]);

	// Auto-play once when the apparatus first scrolls into view.
	useEffect(() => {
		if (inView && phase === "idle") run();
	}, [inView, phase, run]);

	// Reduced-motion (including a live toggle): jump straight to the final state.
	useEffect(() => {
		if (reduced) {
			clearTimers();
			setPassed(N);
			setPhase("done");
		}
	}, [reduced, clearTimers]);

	useEffect(() => () => clearTimers(), [clearTimers]);

	const running = phase === "running";
	const done = phase === "done";

	return (
		<SectionShell id="verify" n={V.n} label={V.label} title={V.title} muted>
			<Reveal>
				<p
					style={{
						fontSize: 16,
						lineHeight: 1.6,
						color: "var(--text-tertiary)",
						margin: "0 0 40px",
						maxWidth: 620,
					}}
				>
					{V.line}
				</p>
			</Reveal>

			<div
				ref={rootRef}
				style={{
					display: "flex",
					flexDirection: "column",
					alignItems: "center",
				}}
			>
				{/* ---------------- the gate ---------------- */}
				<div style={gateCard}>
					<div style={toolbar}>
						<span style={{ display: "flex", color: "var(--text-secondary)" }}>
							<Mark size={16} />
						</span>
						<span style={toolMono}>elench verify</span>
						<span style={tagChip}>fail-closed</span>
						<span
							style={{
								display: "flex",
								alignItems: "center",
								gap: 14,
								marginLeft: "auto",
							}}
						>
							<StatusPill phase={phase} />
							<Button
								type="button"
								variant="outline"
								size="sm"
								onClick={run}
								disabled={running}
							>
								{running ? "Verifying…" : done ? "Re-run verify" : "Run verify"}
							</Button>
						</span>
					</div>

					<div style={planRow}>
						<span style={{ ...eyebrow, fontSize: 9 }}>plan</span>
						<span style={{ color: "var(--text-secondary)" }}>
							sha256:{PLAN.plan_sha256.slice(0, 8)}…{PLAN.plan_sha256.slice(-4)}
						</span>
						<span style={{ color: "var(--text-disabled)" }}>·</span>
						<span>opentofu {PLAN.tofu_version}</span>
						<span style={{ color: "var(--text-disabled)" }}>·</span>
						<span>{PLAN.provider}</span>
					</div>

					{CONTROLS.map((control, i) => {
						const active = i < passed;
						const current = running && i === passed;
						return (
							<div
								key={control.id}
								style={{
									...rowBase,
									borderLeft: current
										? "2px solid var(--text-primary)"
										: "2px solid transparent",
									background: current ? "var(--surface-muted)" : "transparent",
								}}
							>
								<span style={active ? boxOn : boxOff}>
									{active ? (
										reduced ? (
											<span style={checkWrap}>
												<Icon k="check" size={12} sw={2.6} />
											</span>
										) : (
											<motion.span
												style={checkWrap}
												initial={{ scale: 0, opacity: 0 }}
												animate={{ scale: 1, opacity: 1 }}
												transition={{
													type: "spring",
													stiffness: 520,
													damping: 24,
													mass: 0.7,
												}}
											>
												<Icon k="check" size={12} sw={2.6} />
											</motion.span>
										)
									) : null}
								</span>
								<span
									style={{
										...mono,
										fontSize: 13.5,
										color: active ? "var(--text-primary)" : "var(--text-tertiary)",
										transition: reduced ? undefined : "color 0.3s ease",
									}}
								>
									{control.id} · {control.title}
								</span>
								<span
									style={{
										...statusText,
										color: active
											? "var(--text-secondary)"
											: current
												? "var(--text-tertiary)"
												: "var(--text-disabled)",
									}}
								>
									{active ? "pass" : current ? "checking" : "queued"}
								</span>
							</div>
						);
					})}

					{/* the sweep — mounted only while running, and null under reduced motion */}
					{running ? <ScanLine duration={2.6} /> : null}

					{/* verdict — the seal presses in when the gate disposes */}
					{done ? (
						<div style={verdictBar}>
							<Stamp>
								<span style={seal}>
									<Mark size={15} />
									<span style={sealLabel}>passed</span>
								</span>
							</Stamp>
							<span style={{ ...mono, fontSize: 11, color: "var(--text-secondary)" }}>
								{passed}/{N} controls
							</span>
							<span
								style={{
									...mono,
									fontSize: 11,
									color: "var(--text-tertiary)",
									marginLeft: "auto",
								}}
							>
								signed · ed25519
							</span>
						</div>
					) : null}
				</div>

				{/* ---------------- the evidence artifact ---------------- */}
				{done ? (
					<>
						<div
							aria-hidden
							style={{
								display: "flex",
								flexDirection: "column",
								alignItems: "center",
								gap: 6,
								padding: "22px 0",
							}}
						>
							<span style={{ width: 1, height: 20, background: "var(--border-strong)" }} />
							<span style={{ ...eyebrow, fontSize: 9 }}>issues receipt</span>
							<span style={{ color: "var(--text-tertiary)", display: "flex" }}>
								<Icon k="chev" size={16} />
							</span>
						</div>
						<Reveal
							style={{ width: "100%", display: "flex", justifyContent: "center" }}
						>
							<VerifyReceipt />
						</Reveal>
						<p
							style={{
								...mono,
								fontSize: 11,
								color: "var(--text-disabled)",
								letterSpacing: "0.04em",
								margin: "20px 0 0",
								textAlign: "center",
							}}
						>
							The receipt verifies offline against its ed25519 key.
						</p>
					</>
				) : null}
			</div>
		</SectionShell>
	);
}
