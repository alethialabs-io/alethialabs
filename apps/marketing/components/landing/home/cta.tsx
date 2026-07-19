// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import Link from "next/link";
import { Button } from "@repo/ui/button";
import { disp, Icon, Mark, Wrap } from "./primitives";

/** Closing CTA — grid backdrop, the mark, and the two primary actions. */
export function CTA() {
	return (
		<section style={{ padding: "96px 0", borderTop: "1px solid var(--border)", position: "relative", overflow: "hidden" }}>
			<div className="ah-grid-bg ah-grid-cta" />
			<Wrap style={{ position: "relative", textAlign: "center", display: "flex", flexDirection: "column", alignItems: "center" }}>
				<span style={{ color: "var(--text-primary)" }}><Mark size={34} /></span>
				<h2 style={{ ...disp, fontSize: 44, fontWeight: 600, letterSpacing: "-0.04em", margin: "22px 0 16px", maxWidth: 620, color: "var(--text-primary)", lineHeight: 1.05 }}>
					Ship it. Prove it. Keep proving it.
				</h2>
				<p style={{ fontSize: 17, color: "var(--text-secondary)", maxWidth: 520, margin: "0 0 34px", lineHeight: 1.55 }}>
					Open source and self-hostable. Provision into your own cloud with zero stored credentials, and carry a signed receipt for every change.
				</p>
				<div style={{ display: "flex", gap: 13, alignItems: "center", flexWrap: "wrap", justifyContent: "center" }}>
					<Link href="/signup"><Button size="lg" variant="cta">Create an account <Icon k="arrow" size={15} /></Button></Link>
					<Link href="/contact/enterprise"><Button size="lg" variant="outline">Book a demo</Button></Link>
					<Link href="/docs"><Button size="lg" variant="ghost"><Icon k="book" size={15} />Read the docs</Button></Link>
				</div>
			</Wrap>
		</section>
	);
}
