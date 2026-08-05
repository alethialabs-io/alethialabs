// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import Link from "next/link";
import { AlethiaLogo } from "@repo/brand/alethia-logo";

/**
 * Everything after the hero: two short beats and the close.
 *
 * Deliberately thin. The homepage argues once, in the hero, and then shows two
 * things and stops — depth lives at /elench, /cli and /docs. Server components:
 * there is no state here, and the scroll lift is CSS.
 */

/** The console, shown as a real capture rather than a reconstruction. */
export function ConsoleBeat() {
	return (
		<section className="mkt-beat">
			<div className="mkt-wrap">
				<p className="mkt-tag">The console</p>
				<h2 className="mkt-h2">The canvas is the design surface.</h2>
				<p className="mkt-lede">
					Every service and dependency on one canvas — configured in place, compiled
					to OpenTofu, costed live. No YAML, no separate form.
				</p>
				<div className="mkt-plate mkt-lift">
					{/* Replaced by demos/proofs/marketing-capture/stills/03-canvas.png once the
					    seeder's enterprise org-mode lands — see the plan. */}
					<span>
						real capture — 03-canvas.png
						<br />
						console · project architecture
					</span>
				</div>
			</div>
		</section>
	);
}

const KEPT = [
	{ k: "the cluster", v: "Standard EKS, GKE, AKS or k3s" },
	{ k: "the state", v: "Your OpenTofu, your backend" },
	{ k: "the delivery", v: "Real ArgoCD reconciling your Git" },
	{ k: "the platform", v: "AGPL core — self-host all of it" },
];

/**
 * The ownership argument, as proof-objects rather than prose. This is the
 * sharpest wedge against a hosted control plane and it was previously buried
 * eight sections down.
 */
export function KeepBeat() {
	return (
		<section className="mkt-beat mkt-beat--sunken">
			<div className="mkt-wrap">
				<p className="mkt-tag">What you keep when you leave</p>
				<div className="mkt-keep">
					{KEPT.map((row) => (
						<div key={row.k}>
							<p className="mkt-keep-k">{row.k}</p>
							<p className="mkt-keep-v">{row.v}</p>
						</div>
					))}
				</div>
			</div>
		</section>
	);
}

export function Close() {
	return (
		<section className="mkt-close">
			<AlethiaLogo width={30} height={30} className="mkt-close-mark" />
			<h2 className="mkt-h2 mkt-close-h">Provision it. Prove it.</h2>
			<div className="mkt-acts mkt-acts--center">
				<Link className="mkt-btn mkt-btn--solid" href="/signup">
					Start free →
				</Link>
				<Link className="mkt-btn" href="/contact/enterprise">
					Book a demo →
				</Link>
			</div>
		</section>
	);
}
