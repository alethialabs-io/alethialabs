// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { LEGAL_ENTITY } from "@repo/legal/entity";
import type { Metadata } from "next";
import Link from "next/link";
import { LegalShell } from "@/components/legal/legal-shell";

export const metadata: Metadata = {
	title: "AI transparency · Alethia",
	description:
		"What Alethia's AI assistant is, what it can get wrong, who provides it, and what happens to what you send it.",
};

/**
 * The public AI disclosure (#2373).
 *
 * Written as answers to the questions a user actually has, not as a compliance page. The
 * limitations are specific on purpose: "may produce inaccurate output" tells nobody anything, and
 * the point of the disclosure is to let someone decide how much to trust a plan the assistant just
 * proposed.
 *
 * The provider evidence is deliberately NOT rendered from the runtime env here. This page is
 * statically built on the marketing site, which has no access to the console's configuration — and
 * a page that silently showed nothing when the env was absent would read as "no third party
 * involved". The console shows the live per-provider record; this states the commitments that hold
 * whenever the assistant is available at all.
 */
export default function AiTransparencyPage() {
	return (
		<LegalShell title="AI transparency" lastUpdated="August 24, 2026">
			<p>
				Alethia includes an AI assistant. This page says what it is, what it gets
				wrong, and what happens to what you send it. If you never use it, none of
				this applies to you — it is not in the path of a deploy you run yourself.
			</p>

			<h2>You are talking to a machine</h2>
			<p>
				The assistant is an AI system, not a person, and its answers are
				generated. Where it produces text, a plan, or a configuration, that
				output is generated too and is labelled as such in the product.
			</p>

			<h2>What it can get wrong</h2>
			<ul>
				<li>
					It can be <strong>confidently wrong about your infrastructure</strong>.
					It reasons from the configuration it can see, which may be incomplete
					or out of date — including anything changed outside Alethia.
				</li>
				<li>
					It can <strong>misjudge cost and blast radius</strong>. A plan it
					proposes is a draft for you to review, not a decision that has been
					made.
				</li>
				<li>
					It knows nothing about your environment that this product has not told
					it.
				</li>
				<li>
					It <strong>cannot see your cloud credentials</strong>, and never
					receives them. Alethia holds no long-lived cloud keys at all.
				</li>
			</ul>

			<h2>It proposes; it does not apply</h2>
			<p>
				The assistant cannot change your infrastructure on its own. Everything it
				drafts goes through the same review and approval as a change you made by
				hand, and the same verification gate runs on it either way. That limit is
				the reason this is not a high-risk AI system: it decides nothing about a
				person — not access to services, employment, credit, education or
				justice. It drafts infrastructure configuration that a human approves.
			</p>
			<p>
				If that ever changes — if the assistant could apply something without
				approval, or were used to decide something about a person — the
				assessment is redone before it ships, not after.
			</p>

			<h2>Who provides the model, and what happens to what you send</h2>
			<p>
				The assistant runs on models from third-party providers. Your prompt can
				contain your infrastructure, your code, and whatever you pasted into it,
				so before any of that is sent to a provider we record four things: the
				data-processing agreement in force, the transfer mechanism where
				processing happens outside the EEA, how long the provider keeps it, and
				the commitment that it is not used to train their models.
			</p>
			<p>
				<strong>Until all four are recorded, the assistant is switched off.</strong>{" "}
				Not warned about — off. The live record for this deployment, naming each
				provider and its evidence, is shown in the console under AI settings.
				Providers are listed there rather than here because a self-hosted Alethia
				may use different ones under its own agreements.
			</p>
			<p>
				Prompts and responses are not used to train any model, and they are not
				sent to our product analytics. See the{" "}
				<Link href="/legal/subprocessors">subprocessors</Link> page for the
				vendors involved in the service generally.
			</p>

			<h2>If it gets something wrong</h2>
			<p>
				Reply to any support thread, or write to{" "}
				<a href={`mailto:${LEGAL_ENTITY.supportEmail}`}>
					{LEGAL_ENTITY.supportEmail}
				</a>
				, and a person will answer.
			</p>
			<p>
				If the assistant contributed to a real problem — a wrong plan applied, or
				advice that caused an outage or a cost you did not expect — write to the
				same address with the conversation reference. Those are recorded and
				reviewed, not just replied to.
			</p>

			<h2>Using it well</h2>
			<p>
				Read what it proposes before you approve it, the same way you would read
				a colleague&apos;s pull request. Treat cost estimates as estimates. If an
				answer matters, check it against the plan the verification gate produced —
				that is generated from your actual configuration, not by the model.
			</p>
		</LegalShell>
	);
}
