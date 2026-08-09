// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import Link from "next/link";
import { AlethiaLogo } from "@repo/brand/alethia-logo";

import { VerifyReceipt } from "./verify-receipt";

/**
 * Everything after the hero: two short beats and the close.
 *
 * Deliberately thin. The homepage argues once, in the hero, and then shows two
 * things and stops — depth lives at /elench, /cli and /docs. Server components:
 * there is no state here, and the scroll lift is CSS.
 */

/**
 * The receipt, rendered from real engine output.
 *
 * This slot used to hold a full-width 16:9 placeholder waiting on a console
 * screenshot, which read as a large empty rectangle — the worst thing on the
 * page. The receipt needs no capture: it is genuine `packages/core/verify`
 * output, and the download button emits JSON that verifies offline against the
 * published key. Show the artifact rather than a promise of a picture of one.
 */
export function ReceiptBeat() {
	return (
		<section className="mkt-beat">
			<div className="mkt-wrap mkt-split">
				<div>
					<p className="mkt-tag">The receipt</p>
					<h2 className="mkt-h2">Every apply leaves evidence.</h2>
					<p className="mkt-lede">
						A deterministic gate runs between plan and apply and seals the result:
						bound to the hash of the exact plan, the catalog that judged it, and an
						ed25519 signature. Download it and check it yourself — it verifies
						offline, without us.
					</p>
				</div>
				<div className="mkt-lift">
					<VerifyReceipt />
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
