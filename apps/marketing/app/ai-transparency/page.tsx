// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { LEGAL_ENTITY } from "@repo/legal/entity";
import type { Metadata } from "next";
import Link from "next/link";
import { LegalShell } from "@/components/legal/legal-shell";

export const metadata: Metadata = {
	title: "AI transparency",
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
 * involved". It states the commitments that hold whenever the assistant is available at all.
 *
 * docs/legal/AI_ACT_POSITION.md is the internal record this page has to agree with; its §7 lists
 * each statement below and the code it rests on. Change the two together.
 */
export default function AiTransparencyPage() {
	return (
		<LegalShell title="AI transparency" lastUpdated="November 23, 2026">
			<p>
				Alethia includes an AI assistant. This page says what it is, what it gets
				wrong, and what happens to what you send it. If you never use it, none of
				this applies to you — it is not in the path of a deploy you run yourself.
			</p>

			<h2>You are talking to a machine</h2>
			<p>
				The assistant is an AI system, not a person, and its answers are
				generated. Where it produces text, a plan, or a configuration, that
				output is generated too.
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
					receives them.
				</li>
			</ul>

			<h2>It proposes; it does not apply</h2>
			<p>
				Alethia&apos;s assistant cannot change your infrastructure on its own.
				When it proposes a plan or a deploy, nothing runs until you approve it,
				and the same verification gate runs on it as on a change you made by
				hand. That limit is
				the reason this is not a high-risk AI system: it decides nothing about a
				person — not access to services, employment, credit, education or
				justice. It drafts infrastructure configuration that a human approves.
			</p>
			<p>
				If that ever changes — if the assistant could apply something without
				approval, or were used to decide something about a person — the
				assessment is redone before it ships, not after.
			</p>

			<h2>Agents you connect yourself</h2>
			<p>
				You can also point your own AI agent at Alethia, through the MCP server
				or the CLI. That agent is yours, not ours, and it acts with the
				credential you give it. Over MCP it can only read today. Second-person
				approval for applies made by connected agents is part of the beta
				programme; until it ships, an agent acts within the deploy and destroy
				permissions of the account or token it uses. Give an agent a credential
				with no more permission than you would give a colleague you have not
				met.
			</p>

			<h2>Who provides the model, and what happens to what you send</h2>
			<p>
				The assistant runs on models from a third-party provider. On the hosted
				service that is Anthropic, in the United States; it is listed on the{" "}
				<Link href="/legal/subprocessors">subprocessors</Link> page. A
				self-hosted Alethia may use a different provider under its own
				agreements.
			</p>
			<p>
				Your prompt can contain your infrastructure, your code, and whatever you
				pasted into it. For each provider we record four things: the
				data-processing agreement in force, the transfer mechanism where
				processing happens outside the EEA, how long the provider keeps what it
				receives, and its commitment not to use it to train its models.{" "}
				<strong>
					Until all four are recorded, conversations with the assistant are
					switched off.
				</strong>{" "}
				Not warned about — off.
			</p>

			<h2>When you import a repository</h2>
			<p>
				To suggest the infrastructure a repository needs, Alethia reads some of
				its files and sends their text to the same model provider: package
				manifests, Dockerfiles, compose and Kubernetes files, CI configuration,
				and environment templates such as <code>.env.example</code>. It does not
				run any of the code. These files can contain names, email addresses,
				and — by mistake — real secrets, so check a template before you import.
			</p>
			<p>
				The import does not yet check the four records above before it sends
				the files; the conversations do. We are adding the same check to the
				import.
			</p>

			<h2>What we do not do with it</h2>
			<p>
				We do not use your prompts, your files or the responses to train any
				model, and we do not send them to our product analytics. The
				provider&apos;s own commitment not to train on them is one of the four
				records above.
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
