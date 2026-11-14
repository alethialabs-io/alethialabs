// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Which SNS topics may drive the SES event webhook (app/api/webhooks/ses). The operator names them
// as EXACT topic ARNs — account, region and name — in ALETHIA_SES_EVENTS_TOPIC_ARNS. A topic is
// accepted only when its ARN equals one of them byte for byte.
//
// Unset or empty means NO topic is accepted. That is deliberate: suppression decides who stops
// receiving mail, so an unconfigured webhook refuses rather than trusting whatever arrives.
// The hosted deploy sets this (scripts/ci/deploy-console-assemble-env.sh); self-hosters set it to
// their own events topic (docs: Self-Hosting → Email).

/** The env var holding the comma-separated allow-list of SNS topic ARNs. */
export const SES_EVENTS_TOPIC_ARNS_ENV = "ALETHIA_SES_EVENTS_TOPIC_ARNS";

/** An SNS topic ARN in any AWS partition: arn:<partition>:sns:<region>:<12-digit account>:<name>. */
const TOPIC_ARN = /^arn:aws(-[a-z]+)*:sns:[a-z]{2}(-[a-z]+)+-\d:\d{12}:[A-Za-z0-9_-]{1,256}$/;

/**
 * The configured allow-list: each comma-separated entry trimmed, and only well-formed topic ARNs
 * kept. A malformed entry (a bare name, a wildcard, a typo) is dropped rather than matched loosely,
 * so a mistake narrows the list instead of widening it.
 */
export function allowedSesEventsTopicArns(): string[] {
	const raw = process.env[SES_EVENTS_TOPIC_ARNS_ENV] ?? "";
	return raw
		.split(",")
		.map((s) => s.trim())
		.filter((s) => TOPIC_ARN.test(s));
}

/** Whether `topicArn` is exactly one of the configured topics. */
export function isAllowedSesEventsTopic(
	topicArn: string,
	allowed: readonly string[] = allowedSesEventsTopicArns(),
): boolean {
	return allowed.includes(topicArn);
}
