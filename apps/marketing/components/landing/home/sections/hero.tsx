// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

"use client";

import { type CSSProperties, useEffect, useState } from "react";
import {
	animate,
	motion,
	useMotionValue,
	useMotionValueEvent,
	useTransform,
} from "motion/react";
import { Button } from "@repo/ui/button";
import { SAMPLE_RECEIPT } from "@/lib/proof/verify-receipt-sample";
import {
	disp,
	HeroRail,
	Icon,
	type IconKey,
	Mark,
	mono,
	Wrap,
} from "../primitives";
import { VerifyReceipt } from "../verify-receipt";
import { STORY } from "../motion/storyboard";
import { AmbientField } from "../motion/ambient-field";
import { Magnetic } from "../motion/magnetic";
import { Reveal, stagger } from "../motion/reveal";
import { ScanLine } from "../motion/scan-line";
import { Stamp } from "../motion/stamp";
import { stageFromProgress } from "../motion/use-scroll-scene";
import { usePrefersReducedMotion } from "../motion/use-reduced-motion";

/** One lucide key per pipeline stage — repo, plan, verify, apply, cluster. */
const STAGE_ICONS: IconKey[] = ["git", "layers", "shield", "zap", "server"];

/** How long one repo→cluster traverse takes before it loops (seconds). */
const LOOP = 4.4;

/* -------------------------------------------------------------------------- */
/*  Spine — the live, looping proof pipeline that resolves into the receipt.  */
/* -------------------------------------------------------------------------- */

/** Single stage node: a squared icon cell + mono label, lit as the token passes. */
function StageNode({
	k,
	label,
	state,
}: {
	k: IconKey;
	label: string;
	state: "future" | "passed" | "current";
}) {
	const cell: CSSProperties = {
		display: "grid",
		placeItems: "center",
		width: 40,
		height: 40,
		borderRadius: "var(--radius-sm)",
		background: "var(--surface)",
		border:
			"1px solid " +
			(state === "current"
				? "var(--text-primary)"
				: state === "passed"
					? "var(--border-strong)"
					: "var(--border)"),
		color:
			state === "current"
				? "var(--text-primary)"
				: state === "passed"
					? "var(--text-secondary)"
					: "var(--text-disabled)",
		boxShadow: state === "current" ? "var(--shadow-md)" : "none",
		transform: state === "current" ? "scale(1.08)" : "scale(1)",
		transition:
			"transform 0.32s cubic-bezier(0.2,0.9,0.3,1.2), border-color 0.32s ease, color 0.32s ease, box-shadow 0.32s ease",
	};
	return (
		<div
			style={{
				position: "relative",
				zIndex: 1,
				flex: 1,
				display: "flex",
				flexDirection: "column",
				alignItems: "center",
				gap: 10,
				minWidth: 0,
			}}
		>
			<div style={cell}>
				<Icon k={k} size={18} sw={1.7} />
			</div>
			<span
				style={{
					...mono,
					fontSize: 10,
					letterSpacing: "0.14em",
					textTransform: "uppercase",
					color:
						state === "future" ? "var(--text-disabled)" : "var(--text-tertiary)",
				}}
			>
				{label}
			</span>
		</div>
	);
}

/**
 * Spine — a proof token travels repo→plan→verify→apply→cluster on a continuous
 * loop, lighting each stage as it passes. The first time it reaches "cluster"
 * the block below resolves (via `onCluster`). Under reduced motion the whole
 * spine renders fully lit and static (no token, no loop).
 */
function Spine({ onCluster }: { onCluster: () => void }) {
	const stages = STORY.hero.pipeline;
	const reduced = usePrefersReducedMotion();
	const progress = useMotionValue(0);
	const [active, setActive] = useState<number>(reduced ? stages.length - 1 : 0);
	// Under reduced motion the animation never fires, so derive the fully-lit
	// index rather than trusting the (pre-hydration) `active` initializer.
	const shown = reduced ? stages.length - 1 : active;

	// One linear, endlessly-repeating traverse drives token + stage lighting.
	useEffect(() => {
		if (reduced) return;
		const controls = animate(progress, 1, {
			duration: LOOP,
			ease: "linear",
			repeat: Number.POSITIVE_INFINITY,
		});
		return () => controls.stop();
	}, [reduced, progress]);

	// Derive the discrete active-stage index from progress (cheap: ~5 sets/loop).
	useMotionValueEvent(progress, "change", (p) => {
		const idx = stageFromProgress(p, stages.length);
		setActive((prev) => (prev === idx ? prev : idx));
	});

	// Resolve the receipt the first time the token lands on the last stage.
	useEffect(() => {
		if (shown === stages.length - 1) onCluster();
	}, [shown, stages.length, onCluster]);

	// Token + fill positions run along a track inset to the first/last node centers.
	const tokenLeft = useTransform(progress, [0, 1], ["0%", "100%"]);
	const fillWidth = useTransform(progress, [0, 1], ["0%", "100%"]);

	return (
		<div style={{ position: "relative", width: "100%", maxWidth: 640, margin: "0 auto" }}>
			{/* the rail + traveling token live in a track spanning node centers */}
			<div
				aria-hidden
				style={{ position: "absolute", left: "10%", right: "10%", top: 20, height: 1 }}
			>
				<div style={{ position: "absolute", inset: 0, background: "var(--border-strong)" }} />
				{reduced ? (
					<div
						style={{
							position: "absolute",
							left: 0,
							top: 0,
							height: 1,
							width: "100%",
							background: "var(--text-primary)",
							opacity: 0.5,
						}}
					/>
				) : (
					<>
						<motion.div
							style={{
								position: "absolute",
								left: 0,
								top: 0,
								height: 1,
								width: fillWidth,
								background: "var(--text-primary)",
								opacity: 0.55,
							}}
						/>
						<motion.span
							style={{
								position: "absolute",
								top: 0,
								left: tokenLeft,
								x: "-50%",
								y: "-50%",
								display: "grid",
								placeItems: "center",
								width: 24,
								height: 24,
								borderRadius: "var(--radius-sm)",
								border: "1px solid var(--text-primary)",
								background: "var(--surface-raised)",
								color: "var(--text-primary)",
								boxShadow: "var(--shadow-md)",
								zIndex: 2,
							}}
						>
							<Mark size={13} />
						</motion.span>
					</>
				)}
			</div>

			{/* the stage nodes */}
			<div style={{ position: "relative", display: "flex", alignItems: "flex-start" }}>
				{stages.map((label, i) => (
					<StageNode
						key={label}
						k={STAGE_ICONS[i] ?? "layers"}
						label={label}
						state={shown === i ? "current" : shown > i ? "passed" : "future"}
					/>
				))}
			</div>
		</div>
	);
}

/* -------------------------------------------------------------------------- */
/*  Receipt block — the spine resolves into the real signed VerifyReceipt.    */
/* -------------------------------------------------------------------------- */

/**
 * ReceiptStage — holds the causal connector, the "printing" clip-reveal of the
 * real `<VerifyReceipt/>`, a looping re-scan, and the stamped ed25519 seal.
 * `live` flips true when the pipeline first reaches "cluster" (or immediately
 * under reduced motion), which triggers the reveal.
 */
function ReceiptStage({ live }: { live: boolean }) {
	const reduced = usePrefersReducedMotion();
	const keyId = SAMPLE_RECEIPT.key_id;

	return (
		<div style={{ position: "relative", width: "100%", maxWidth: 720, margin: "0 auto" }}>
			{/* causal connector: cluster → signed receipt */}
			<div
				aria-hidden
				style={{
					display: "flex",
					flexDirection: "column",
					alignItems: "center",
					gap: 8,
					margin: "26px 0 22px",
					opacity: live ? 1 : 0,
					transition: "opacity 0.6s ease",
				}}
			>
				<span style={{ width: 1, height: 26, background: "linear-gradient(var(--border-strong), var(--text-tertiary))" }} />
				<span style={{ color: "var(--text-tertiary)", display: "flex" }}>
					<Icon k="chev" size={15} sw={1.7} />
				</span>
				<span
					style={{
						...mono,
						fontSize: 10,
						letterSpacing: "0.18em",
						textTransform: "uppercase",
						color: "var(--text-tertiary)",
					}}
				>
					Signed receipt
				</span>
			</div>

			{/* the receipt, revealed with a top→bottom "print" wipe + a re-scan */}
			<div style={{ position: "relative", overflow: "hidden", minHeight: 300 }}>
				<motion.div
					initial={false}
					animate={
						live
							? { clipPath: "inset(0 0 0% 0)", opacity: 1, y: 0 }
							: { clipPath: "inset(0 0 100% 0)", opacity: 0, y: 8 }
					}
					transition={{ duration: reduced ? 0 : 1.25, ease: [0.16, 1, 0.3, 1] }}
					style={{ willChange: "clip-path" }}
				>
					<VerifyReceipt />
				</motion.div>
				{live ? <ScanLine duration={2.8} /> : null}
			</div>

			{/* the ed25519 seal presses in once the print settles */}
			{live ? (
				<div style={{ position: "absolute", top: -16, right: 14, zIndex: 3 }}>
					<Stamp delay={reduced ? 0 : 1.05}>
						<div
							style={{
								display: "inline-flex",
								alignItems: "center",
								gap: 9,
								padding: "7px 11px",
								border: "1px solid var(--border-strong)",
								borderRadius: "var(--radius-sm)",
								background: "var(--surface-raised)",
								boxShadow: "var(--shadow-md)",
							}}
						>
							<span
								style={{
									display: "grid",
									placeItems: "center",
									width: 18,
									height: 18,
									border: "1px solid var(--text-primary)",
									color: "var(--text-primary)",
								}}
							>
								<Icon k="check" size={12} sw={2.4} />
							</span>
							<span
								style={{
									...mono,
									fontSize: 9.5,
									letterSpacing: "0.14em",
									textTransform: "uppercase",
									color: "var(--text-secondary)",
								}}
							>
								signed · ed25519
							</span>
							<span style={{ ...mono, fontSize: 9.5, color: "var(--text-tertiary)" }}>
								key {keyId}
							</span>
						</div>
					</Stamp>
				</div>
			) : null}
		</div>
	);
}

/* -------------------------------------------------------------------------- */

/**
 * Hero — the full-bleed centerpiece: the WebGL ambient field, the keyless
 * headline + dual CTAs (the single --cta conversion button), and the live proof
 * pipeline that continuously runs repo→plan→verify→apply→cluster and resolves
 * into a real signed elench receipt. Self-evidences the whole product in one
 * motion; degrades to a fully-assembled, static composition under reduced motion.
 */
export function Hero() {
	const reduced = usePrefersReducedMotion();
	const [receiptLive, setReceiptLive] = useState<boolean>(reduced);

	// Under reduced motion the receipt is present from the first paint.
	useEffect(() => {
		if (reduced) setReceiptLive(true);
	}, [reduced]);

	return (
		<section style={{ position: "relative", overflow: "hidden", paddingTop: 76, paddingBottom: 80 }}>
			<AmbientField intensity={1.1} />

			<div style={{ position: "relative", zIndex: 1 }}>
				<Wrap
					style={{
						textAlign: "center",
						display: "flex",
						flexDirection: "column",
						alignItems: "center",
					}}
				>
					<HeroRail kicker={STORY.hero.kicker} status={STORY.hero.status} maxWidth={600} />

					<Reveal>
						<h1
							className="ah-h1"
							style={{
								...disp,
								fontFamily: "var(--font-grotesk)",
								fontSize: 62,
								fontWeight: 600,
								letterSpacing: "-0.045em",
								lineHeight: 1.03,
								margin: 0,
								maxWidth: 860,
								color: "var(--text-primary)",
							}}
						>
							{STORY.hero.h1}
							<br />
							<span style={{ color: "var(--text-tertiary)" }}>{STORY.hero.h1b}</span>
						</h1>
					</Reveal>

					<Reveal delay={stagger(1)}>
						<p
							style={{
								fontSize: 18.5,
								color: "var(--text-secondary)",
								maxWidth: 620,
								margin: "24px auto 32px",
								lineHeight: 1.55,
							}}
						>
							{STORY.hero.sub}
						</p>
					</Reveal>

					<Reveal delay={stagger(2)}>
						<div
							style={{
								display: "flex",
								alignItems: "center",
								gap: 13,
								marginBottom: 20,
								flexWrap: "wrap",
								justifyContent: "center",
							}}
						>
							<Magnetic>
								<Button size="lg">
									{STORY.hero.ctaPrimary}
									<Icon k="arrow" size={15} />
								</Button>
							</Magnetic>
							<Button variant="outline" size="lg">
								<Icon k="book" size={15} />
								{STORY.hero.ctaSecondary}
							</Button>
						</div>
					</Reveal>

					<Reveal delay={stagger(3)}>
						<p
							style={{
								...mono,
								fontSize: 12,
								color: "var(--text-tertiary)",
								letterSpacing: "0.02em",
								margin: "0 0 52px",
							}}
						>
							{STORY.hero.strip}
						</p>
					</Reveal>

					{/* the WOW: the live proof pipeline → the real signed receipt */}
					<Reveal delay={stagger(4)} amount={0.15} style={{ width: "100%" }}>
						<Spine onCluster={() => setReceiptLive(true)} />
						<ReceiptStage live={receiptLive} />
					</Reveal>
				</Wrap>
			</div>
		</section>
	);
}
