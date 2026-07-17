// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import Link from "next/link";
import { Button } from "@repo/ui/button";
import { disp, HeroRail, Icon, mono, Wrap } from "./primitives";

/**
 * Landing hero — receipt-first promise + the product video. The looping ambient
 * (`hero-loop.mp4`, a real capture) is the placeholder; the full narrated master
 * slots in here (swap the src / wire `NEXT_PUBLIC_HERO_VIDEO_URL`).
 */
export function Hero() {
	return (
		<section style={{ position: "relative", paddingTop: 78, paddingBottom: 64, overflow: "hidden" }}>
			<div className="ah-grid-bg" />
			<Wrap style={{ position: "relative", textAlign: "center", display: "flex", flexDirection: "column", alignItems: "center" }}>
				<HeroRail kicker="alethia · control plane" status="keyless · evidence-backed" maxWidth={620} />
				<h1 className="ah-h1" style={{ ...disp, fontSize: 64, fontWeight: 600, letterSpacing: "-0.045em", lineHeight: 1.03, margin: 0, maxWidth: 900, color: "var(--text-primary)" }}>
					Own your infrastructure.<br />
					<span style={{ color: "var(--text-tertiary)" }}>Prove every change.</span>
				</h1>
				<p style={{ fontSize: 18.5, color: "var(--text-secondary)", maxWidth: 660, margin: "24px 0 32px", lineHeight: 1.55 }}>
					Alethia takes your repo to a running, configured Kubernetes cluster — in <b style={{ color: "var(--text-primary)", fontWeight: 600 }}>your own cloud</b>, with zero stored credentials. Every plan is verified and carries a signed receipt. Ship it, prove it, and keep proving it.
				</p>
				<div style={{ display: "flex", alignItems: "center", gap: 13, marginBottom: 52, flexWrap: "wrap", justifyContent: "center" }}>
					<Link href="/signup"><Button size="lg" variant="cta">Create an account <Icon k="arrow" size={15} /></Button></Link>
					<Link href="/contact/enterprise"><Button size="lg" variant="outline">Book a demo</Button></Link>
				</div>
				<div style={{ width: "100%", maxWidth: 1040, border: "1px solid var(--border)", background: "var(--surface)", boxShadow: "var(--shadow-lg)", overflow: "hidden" }}>
					<video
						src="/mkt-assets/home/hero-loop.mp4"
						poster="/mkt-assets/home/dark/canvas.jpg"
						autoPlay
						muted
						loop
						playsInline
						style={{ display: "block", width: "100%", height: "auto" }}
					/>
				</div>
			</Wrap>
		</section>
	);
}
