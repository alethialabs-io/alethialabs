// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

"use client";

import Link from "next/link";
import { useState } from "react";

import { FIELD_CATALOG, FIELD_KEY_ID } from "@/lib/proof/plan-field";
import { Field, type FieldVerdict } from "./field";

/**
 * The hero.
 *
 * A client component because the field and the readout share one piece of state
 * (the last verdict). It still server-renders, which matters: the `<h1>` is the
 * LCP element and must be in the initial HTML. For the same reason the headline
 * animates `filter` and `transform` only — never `opacity`, because an element
 * at `opacity: 0` is excluded from LCP candidacy and would push the metric out
 * by the length of the fade.
 */
export function Hero() {
	const [verdict, setVerdict] = useState<FieldVerdict | null>(null);
	const subject = verdict?.subject;

	return (
		<section className="mkt-hero">
			<Field onVerdict={setVerdict} />

			<div className="mkt-hero-in">
				<p className="mkt-eyebrow">Multi-cloud Kubernetes control plane</p>

				<h1 className="mkt-h1">
					<span>Infrastructure,</span> <span>cross-examined.</span>
				</h1>

				<p className="mkt-sub">
					Alethia provisions Kubernetes into <b>your own</b> cloud account holding{" "}
					<b>zero credentials</b>, and seals a signed receipt for every apply.
				</p>

				<div className="mkt-acts">
					<Link className="mkt-btn mkt-btn--solid" href="/signup">
						Start free →
					</Link>
					<Link className="mkt-btn" href="/docs">
						Read the docs →
					</Link>
				</div>

				{/* The field is decorative and aria-hidden; this is where its output
				    becomes real, announced text. */}
				<div className="mkt-readout" aria-live="polite">
					<p className="mkt-readout-hd">
						<span>{subject ? "Verdict" : "Drag a resource into the gate"}</span>
						<s aria-hidden="true" />
						<span>{FIELD_CATALOG}</span>
					</p>

					<p className="mkt-readout-addr">{subject ? subject.address : "—"}</p>

					<p className="mkt-readout-line">
						<span className="mkt-verdict">
							{subject ? subject.status.replace("_", " ") : "idle"}
						</span>
						<span>
							{subject
								? subject.controlId
									? `${subject.controlId} — ${subject.note}`
									: subject.note
								: "the gate runs between plan and apply"}
						</span>
					</p>

					<p className="mkt-readout-hint">
						{!subject
							? "They fall, they collide, they pile up. Throw them around."
							: subject.status === "pass"
								? `Sealed into the receipt with the plan hash, signed ed25519 ${FIELD_KEY_ID}.`
								: "Never a silent pass — the gate reports what it could not see."}
					</p>
				</div>
			</div>
		</section>
	);
}
