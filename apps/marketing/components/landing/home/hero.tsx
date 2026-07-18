"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Button } from "@repo/ui/button";
import { disp, mono, HeroRail, Icon, Wrap } from "./primitives";
import { VerifyReceipt } from "./verify-receipt";

/**
 * Landing hero — grid backdrop, the "own it / keyless / prove it" headline, dual
 * CTAs, and the centerpiece: a REAL signed elench verify receipt. The proof object
 * self-evidences the claim instead of asserting it (see verify-receipt.tsx).
 */
export function Hero() {
	return (
		<section style={{ position: "relative", paddingTop: 78, paddingBottom: 64, overflow: "hidden" }}>
			<div className="ah-grid-bg" />
			<Wrap style={{ position: "relative", textAlign: "center", display: "flex", flexDirection: "column", alignItems: "center" }}>
				<HeroRail kicker="alethia · control plane" status="holding zero keys" maxWidth={600} />
				<h1 className="ah-h1" style={{ ...disp, fontSize: 62, fontWeight: 600, letterSpacing: "-0.045em", lineHeight: 1.03, margin: 0, maxWidth: 840, color: "var(--text-primary)" }}>
					From a repo to a cluster you own.<br />
					<span style={{ color: "var(--text-tertiary)" }}>Proven. Holding zero keys.</span>
				</h1>
				<p style={{ fontSize: 18.5, color: "var(--text-secondary)", maxWidth: 620, margin: "24px 0 32px", lineHeight: 1.55 }}>
					Alethia turns a repository into an owned, running Kubernetes cluster on AWS,
					GCP, Azure, or Hetzner — provisioned keyless, with a signed receipt for every
					change.
				</p>
				<div style={{ display: "flex", alignItems: "center", gap: 13, marginBottom: 20, flexWrap: "wrap", justifyContent: "center" }}>
					<Button size="lg">Deploy your repo <Icon k="arrow" size={15} /></Button>
					<Button size="lg" variant="outline"><Icon k="book" size={15} />Read the docs</Button>
				</div>
				<p style={{ ...mono, fontSize: 12, color: "var(--text-tertiary)", letterSpacing: "0.02em", margin: "0 0 44px" }}>
					the plan → apply gate, one job · catalog{" "}
					<span style={{ color: "var(--text-secondary)" }}>elench-controls-0.4.0</span> ·{" "}
					<span style={{ color: "var(--text-secondary)" }}>ed25519</span> signed
				</p>
				<VerifyReceipt />
			</Wrap>
		</section>
	);
}
