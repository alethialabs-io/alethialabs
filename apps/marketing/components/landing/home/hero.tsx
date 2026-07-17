// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import Link from "next/link";
import { Button } from "@repo/ui/button";
import { disp, HeroRail, Icon, mono, Wrap } from "./primitives";
import { MediaShot } from "./media-shot";

/** Landing hero — receipt-first promise + the real console (the architecture canvas). */
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
				<div style={{ display: "flex", alignItems: "center", gap: 13, marginBottom: 54, flexWrap: "wrap", justifyContent: "center" }}>
					<Link href="/signup"><Button size="lg" variant="cta">Create an account <Icon k="arrow" size={15} /></Button></Link>
					<Link href="/contact/enterprise"><Button size="lg" variant="outline">Book a demo</Button></Link>
				</div>
				<div style={{ width: "100%", maxWidth: 1060 }}>
					<MediaShot src="/mkt-assets/home/dark/canvas.jpg" alt="The Alethia console — a production project on the architecture canvas: VPC, cluster, database, cache, DNS, GitOps, storage — with live cost and activity." priority />
				</div>
				<p style={{ ...mono, fontSize: 10.5, letterSpacing: "0.16em", textTransform: "uppercase", color: "var(--text-disabled)", marginTop: 16 }}>
					A real screenshot of the console — not a mockup
				</p>
			</Wrap>
		</section>
	);
}
