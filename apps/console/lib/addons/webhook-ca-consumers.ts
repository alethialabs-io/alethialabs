// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from "zod";
import type { TemplateId } from "@/components/create-project/templates";

/**
 * The project-level webhook-CA marker (#4990).
 *
 * A marketplace add-on that needs the cert-manager CONTROLLER for its admission webhook says so on
 * its own install spec (`requiresCertManager`, #3228). A workload that is NOT an add-on cannot:
 * KServe reaches the cluster as the AI Workloads starter's own ArgoCD Application, from the
 * customer's apps repo, so no install spec exists to carry the flag. KServe v0.15.2's chart always
 * renders a cert-manager Certificate and a namespaced SelfSigned Issuer, so without the controller
 * and CRDs it cannot start.
 *
 * So the PROJECT declares it: `projects.webhook_ca_consumers`, emitted on the config snapshot as
 * `webhook_ca_consumers` and read by the Go `ProjectConfig.WebhookCAConsumers` into the same
 * `InfraFacts.WebhookCAConsumers` fact the add-on flag feeds. The platform cert-manager Application
 * then installs issuer-free — no domain, on all five clouds — and stays the ONE owner of the
 * cert-manager CRDs (#1722). It never requests a ClusterIssuer; public certificates remain the
 * managed-certificate switch's job.
 *
 * A closed list, not free text: each entry is a statement about a specific chart's webhook, and a
 * name nobody verified would install cert-manager on a claim nothing backs.
 */
export const WEBHOOK_CA_CONSUMERS = ["kserve"] as const;

/** One workload the project declares needs cert-manager for its webhook CA. */
export type WebhookCaConsumer = (typeof WEBHOOK_CA_CONSUMERS)[number];

/** Validates the marker on every write path (the create action, the CLI, the form schema). */
export const webhookCaConsumersSchema = z
	.array(z.enum(WEBHOOK_CA_CONSUMERS))
	.max(WEBHOOK_CA_CONSUMERS.length);

/**
 * The marker a quick-create template sets on the project it creates. Only AI Workloads declares
 * one: its starter (github.com/alethialabs-io/alethia-starter-ai) ships KServe.
 *
 * @param template the template the user picked on the create screen
 * @returns the consumers to store on `project.webhook_ca_consumers` (empty for the others)
 */
export function webhookCaConsumersForTemplate(
	template: TemplateId,
): WebhookCaConsumer[] {
	return template === "ai" ? ["kserve"] : [];
}

/**
 * Normalises the marker, both where it is written and where it is emitted onto the config
 * snapshot: sorted and de-duplicated, so the frozen snapshot bytes do not churn on insertion order.
 * `null`/`undefined` (an input that did not set it, or a mocked row) reads as no consumers.
 *
 * @param stored the marker as given or as stored in `projects.webhook_ca_consumers`
 * @returns the consumers to emit, or an empty list
 */
export function normalizeWebhookCaConsumers(
	stored: readonly WebhookCaConsumer[] | null | undefined,
): WebhookCaConsumer[] {
	return Array.from(new Set(stored ?? [])).sort();
}
