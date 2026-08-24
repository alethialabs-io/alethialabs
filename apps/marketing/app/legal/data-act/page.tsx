// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { LEGAL_ENTITY } from "@repo/legal/entity";
import type { Metadata } from "next";
import Link from "next/link";
import { LegalShell } from "@/components/legal/legal-shell";

export const metadata: Metadata = {
	title: "Switching and data portability · Alethia",
	description:
		"How to leave Alethia: what you can take with you, how long you have, and what it costs (nothing).",
};

/**
 * The Data Act switching and portability commitments (#2373).
 *
 * Regulation (EU) 2023/2854 gives a customer of a data-processing service the right to switch away,
 * with a transition window, a retrieval window, and — since 12 January 2027 — no switching charge.
 *
 * The reason this page is short and specific is that Alethia is unusually well placed to make the
 * commitment honestly: the infrastructure was never ours. It runs in the customer's own cloud
 * account, from OpenTofu they can read, and we hold no keys to it. So "switching away" is mostly a
 * question of what WE hold about them, which is a much smaller answer than most services can give —
 * and saying so plainly is more useful than reciting the regulation.
 */
export default function DataActPage() {
	return (
		<LegalShell title="Switching and data portability" lastUpdated="August 24, 2026">
			<p>
				This page is about leaving. It says what you can take, how long you have
				to take it, and what it costs — which is nothing.
			</p>

			<h2>Most of it was never ours to hold</h2>
			<p>
				Alethia provisions infrastructure into <em>your</em> cloud account, using
				OpenTofu you can read, under credentials we never store. Your clusters,
				databases, networks and their state belong to you and stay where they
				are. If you stop using Alethia tomorrow, nothing is provisioned away and
				nothing stops running.
			</p>
			<p>
				That is the substance of the switching right in our case, and it is worth
				stating before the procedural part: there is no lock-in to unwind because
				there was no custody to begin with.
			</p>

			<h2>What we hold, and how to take it</h2>
			<p>
				What Alethia holds is the design and the record: your projects and their
				component graphs, environments, deploy history, evidence receipts,
				connector configuration (never the credentials), and your organization
				and members.
			</p>
			<p>
				You can export all of it in a machine-readable archive from the console,
				at any time and without asking us. The archive ships with a manifest
				listing every file, its record count and its digest, so you can verify
				you received the whole thing. Where a signing key is configured the
				manifest is signed; where it is not, it says so rather than looking
				signed.
			</p>

			<h2>Transition and retrieval</h2>
			<ul>
				<li>
					<strong>Transition window — 30 days.</strong> From the day you tell us
					you are switching, your account keeps working normally while you move.
					We do not degrade it, and we do not treat notice as cancellation.
				</li>
				<li>
					<strong>Retrieval window — 30 further days.</strong> After the service
					ends, your exportable data remains retrievable for another 30 days.
					You do not need an active subscription to retrieve it.
				</li>
				<li>
					<strong>Then it is deleted.</strong> At the end of the retrieval window
					we delete what we hold, apart from records a legal obligation requires
					us to keep — statutory accounting records, and proof of which terms
					your account accepted. Those are listed with their basis in your
					deletion record.
				</li>
			</ul>
			<p>
				If you need longer, ask. A window that expires while somebody is
				genuinely mid-migration serves nobody.
			</p>

			<h2>No switching charge</h2>
			<p>
				We do not charge for switching, for exporting, or for retrieval — not a
				fee, not an egress cost, not a &ldquo;professional services&rdquo;
				engagement. This is a commitment we make now rather than one we start
				making when the Data Act requires it in January 2027.
			</p>
			<p>
				You still pay your own cloud provider for your own infrastructure, as you
				did all along. That bill was never ours.
			</p>

			<h2>Getting help, or complaining</h2>
			<p>
				Write to{" "}
				<a href={`mailto:${LEGAL_ENTITY.supportEmail}`}>
					{LEGAL_ENTITY.supportEmail}
				</a>{" "}
				and a person will answer. If you are a consumer and we have not resolved
				it, the routes open to you are on the{" "}
				<Link href="/consumer-rights">consumer rights</Link> page. For anything
				about personal data specifically, see{" "}
				<Link href="/privacy/requests">privacy requests</Link>.
			</p>
		</LegalShell>
	);
}
