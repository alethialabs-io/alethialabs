// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// AI transparency, and the gate that stops an external provider being used before we can say what
// happens to what is sent to it (#2373).
//
// Two requirements meet here, and the second is the one with teeth:
//
//   IDENTIFY  — a person interacting with an AI system has to be told so, told who provides it,
//               what its limits are, and how to reach a human. That is disclosure, and it lives in
//               `AI_SYSTEM_DISCLOSURE` so the console and the public page say the same thing.
//
//   FAIL CLOSED — a customer's prompt can carry their infrastructure, their code, and whatever they
//               pasted into it. Sending that to a third party requires a processor agreement, a
//               lawful transfer mechanism, a known retention, and a commitment that it is not
//               trained on. Until each of those is CONFIGURED and named, the provider is refused —
//               not warned about, refused. A warning would be a feature that ships anyway.
//
// The evidence is read from the environment rather than hard-coded, because it is a deployment
// fact: a self-hosted instance pointing at its own endpoint under its own DPA has different
// evidence from ours, and hard-coding ours would state something untrue about theirs.

import { env } from "next-runtime-env";
import type { ProviderId } from "@/lib/config/ai";

/** What a person must be told when they are talking to the assistant. */
export interface AiSystemDisclosure {
	/** Plainly: this is an AI system. */
	readonly identification: string;
	/** What it can get wrong, in words that are useful rather than defensive. */
	readonly limitations: readonly string[];
	/** What it is allowed to do on its own, and what needs a human. */
	readonly autonomy: string;
	/** How to reach a person. */
	readonly humanContact: string;
	/** How to report something it got wrong in a way that mattered. */
	readonly incidentPath: string;
}

/**
 * The disclosure, in one place, rendered by both the console and the public page.
 *
 * Written for the reader, not for us. "May produce inaccurate output" tells nobody anything; naming
 * what it actually gets wrong is what lets someone decide how much to trust a plan it proposed.
 */
export const AI_SYSTEM_DISCLOSURE: AiSystemDisclosure = {
	identification:
		"You are interacting with an AI assistant, not a person. Its responses are generated.",
	limitations: [
		"It can be confidently wrong about your infrastructure — it reasons from the configuration it can see, which may be incomplete or out of date.",
		"It can misjudge cost and blast radius. A plan it proposes is a draft to review, not a decision that has been made.",
		"It does not know anything about your environment that this product has not told it, including changes made outside Alethia.",
		"It cannot see your cloud credentials, and it never receives them.",
	],
	autonomy:
		"The assistant proposes; it does not apply. Every change to real infrastructure goes through the same review and approval as one you made by hand, and the verification gate runs on it either way.",
	humanContact:
		"Reply to any support thread, or write to support@alethialabs.io, and a person will answer.",
	incidentPath:
		"If the assistant contributed to a real problem — a wrong plan applied, or advice that caused an outage or a cost you did not expect — write to support@alethialabs.io with the conversation reference. It is recorded and reviewed, not just answered.",
};

/**
 * The EU AI Act classification of this system, stated because the honest answer is boring and
 * being vague about it reads as hiding something.
 *
 * A general-purpose assistant embedded in a developer tool, used to draft configuration a human
 * reviews and approves, is not a high-risk system under Annex III: it does not decide access to
 * essential services, employment, credit, education or justice. What DOES apply is the art. 50
 * transparency duty — a user must know they are talking to a machine — which is what
 * AI_SYSTEM_DISCLOSURE discharges.
 */
export const AI_SYSTEM_CLASSIFICATION = {
	role: "Deployer of a general-purpose AI model, embedded as an assistant.",
	highRisk: false,
	highRiskBasis:
		"Not an Annex III use case: the assistant drafts infrastructure configuration that a human reviews and approves, and decides nothing about a person's access to services, employment, credit, education or justice.",
	transparencyDuty:
		"Article 50 applies — users are told they are interacting with an AI system, and generated output is identifiable as generated.",
	/** What would change the answer, so the classification is re-examined rather than assumed. */
	reassessIf:
		"The assistant gains the ability to apply a change without human approval, or is used to make a decision about a person rather than about infrastructure.",
} as const;

// ── The fail-closed provider gate ───────────────────────────────────────────────────────────────

/** The four things that must be in place before a prompt may leave this system. */
export interface ProviderEvidence {
	/** The data-processing agreement in force, e.g. "Anthropic Commercial Terms + DPA, 2026-08-01". */
	readonly dpa: string | null;
	/** The transfer mechanism for any processing outside the EEA, or the reason none is needed. */
	readonly transfer: string | null;
	/** What the provider retains, and for how long. */
	readonly retention: string | null;
	/** The commitment that inputs and outputs are not used for training. */
	readonly noTraining: string | null;
}

/** Env var names per provider. Read at runtime so a deployment can supply its own answers. */
const EVIDENCE_ENV: Record<ProviderId, Record<keyof ProviderEvidence, string>> = {
	anthropic: {
		dpa: "ALETHIA_AI_ANTHROPIC_DPA",
		transfer: "ALETHIA_AI_ANTHROPIC_TRANSFER",
		retention: "ALETHIA_AI_ANTHROPIC_RETENTION",
		noTraining: "ALETHIA_AI_ANTHROPIC_NO_TRAINING",
	},
	openai: {
		dpa: "ALETHIA_AI_OPENAI_DPA",
		transfer: "ALETHIA_AI_OPENAI_TRANSFER",
		retention: "ALETHIA_AI_OPENAI_RETENTION",
		noTraining: "ALETHIA_AI_OPENAI_NO_TRAINING",
	},
};

/** The configured evidence for a provider — whatever is there, and nulls for what is not. */
export function providerEvidence(provider: ProviderId): ProviderEvidence {
	const keys = EVIDENCE_ENV[provider];
	const read = (name: string) => {
		const v = env(name);
		return v && v.trim().length > 0 ? v.trim() : null;
	};
	return {
		dpa: read(keys.dpa),
		transfer: read(keys.transfer),
		retention: read(keys.retention),
		noTraining: read(keys.noTraining),
	};
}

/** The verdict for one provider: usable, or refused with what is missing. */
export type ProviderGate =
	| { readonly allowed: true; readonly evidence: ProviderEvidence }
	| { readonly allowed: false; readonly missing: (keyof ProviderEvidence)[]; readonly message: string };

/** The four keys, in the order the refusal lists them. Typed so a field added to ProviderEvidence
 *  and forgotten here is a compile error — which is the check that keeps the gate total. */
const EVIDENCE_KEYS: readonly (keyof ProviderEvidence)[] = [
	"dpa",
	"transfer",
	"retention",
	"noTraining",
];

/** Human names for the four, used in the refusal message. */
const EVIDENCE_LABEL: Record<keyof ProviderEvidence, string> = {
	dpa: "a data-processing agreement",
	transfer: "a transfer mechanism (or a stated reason none is needed)",
	retention: "the provider's retention period",
	noTraining: "a no-training commitment",
};

/**
 * Whether a prompt may be sent to this provider.
 *
 * FAIL-CLOSED: every missing item refuses. There is deliberately no "warn and continue" — the whole
 * failure mode this guards against is a feature that ships with the paperwork "to follow", and a
 * warning is what that looks like in practice.
 *
 * The one exemption is the scripted E2E model, which is not a provider at all: it sends nothing
 * anywhere. That is handled by the caller (`isAiMock`), not here, so this function has no bypass of
 * its own to be misused.
 */
export function providerGate(provider: ProviderId): ProviderGate {
	const evidence = providerEvidence(provider);
	// Declared, not cast: EVIDENCE_KEYS is typed at its declaration so the compiler CHECKS that it
	// covers every field, rather than being told it does. Object.keys() widens to string[], and
	// asserting it back is exactly the cast this repo's lint refuses.
	const missing = EVIDENCE_KEYS.filter((k) => evidence[k] === null);
	if (missing.length === 0) return { allowed: true, evidence };
	return {
		allowed: false,
		missing,
		message:
			`The AI assistant is disabled for ${provider}: ${missing.map((m) => EVIDENCE_LABEL[m]).join(", ")} ` +
			`${missing.length === 1 ? "is" : "are"} not configured. A prompt can carry a customer's ` +
			`infrastructure and code, so it is not sent to a third party until what happens to it is ` +
			`recorded. Set ${missing.map((m) => EVIDENCE_ENV[provider][m]).join(", ")}.`,
	};
}

/** The public transparency record for every provider this deployment is configured to use. */
export function transparencyRecord(providers: readonly ProviderId[]) {
	return providers.map((provider) => {
		const gate = providerGate(provider);
		return {
			provider,
			allowed: gate.allowed,
			evidence: gate.allowed ? gate.evidence : providerEvidence(provider),
			missing: gate.allowed ? [] : gate.missing,
		};
	});
}
