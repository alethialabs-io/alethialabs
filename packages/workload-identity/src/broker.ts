// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from "zod";

/** The stable workload subject trusted by managed-cloud federation policies. */
export const WORKLOAD_SUBJECT = "alethia-connector";

/** The shortest assertion lifetime supported by every assertion source. */
export const MIN_ASSERTION_TTL_SECONDS = 60;

/** The longest assertion lifetime permitted by the workload-identity boundary. */
export const MAX_ASSERTION_TTL_SECONDS = 600;

/** Managed clouds whose token exchanges may consume a broker assertion. */
export const workloadProviderSchema = z.enum([
  "aws",
  "gcp",
  "azure",
  "alibaba",
]);
export type WorkloadProvider = z.infer<typeof workloadProviderSchema>;

/**
 * The audience each managed cloud's federation trust pins for an Alethia workload assertion.
 *
 * ONE copy, on purpose. The console's session modules forward these as `request.audience`, the
 * connector setup (`infra/connector/<cloud>/main.tf`, `gcp-setup.sh`) pins the same strings on the
 * customer side, and the E2E assertion broker refuses any other audience for a provider. A second
 * hand-typed copy in the broker's environment (`PROVIDER_AUDIENCES_JSON`, #4236) meant a change
 * here failed the nightly with `audience_not_allowed` and no repo diff to explain it.
 */
export const WORKLOAD_PROVIDER_AUDIENCES: Readonly<
  Record<WorkloadProvider, string>
> = {
  aws: "sts.amazonaws.com",
  gcp: "alethia-gcp-wif",
  azure: "api://AzureADTokenExchange",
  alibaba: "sts.aliyuncs.com",
};

/** Returns the one audience a broker assertion for `provider` may carry. */
export function providerAudience(provider: WorkloadProvider): string {
  return WORKLOAD_PROVIDER_AUDIENCES[provider];
}

/** GitHub Actions identity fields the broker cross-checks against the bearer token claims. */
export const brokerRunSchema = z
  .object({
    repository: z
      .string()
      .regex(/^[^/\s]+\/[^/\s]+$/)
      .max(200),
    workflowRef: z.string().min(1).max(500),
    runId: z.string().regex(/^\d+$/).max(30),
    runAttempt: z.number().int().positive(),
  })
  .strict();
export type BrokerRun = z.infer<typeof brokerRunSchema>;

/** The authenticated request body accepted by the E2E assertion broker. */
export const brokerAssertionRequestSchema = z
  .object({
    provider: workloadProviderSchema,
    audience: z.string().trim().min(1).max(500),
    subject: z.literal(WORKLOAD_SUBJECT).default(WORKLOAD_SUBJECT),
    ttlSeconds: z
      .number()
      .int()
      .min(MIN_ASSERTION_TTL_SECONDS)
      .max(MAX_ASSERTION_TTL_SECONDS)
      .default(MAX_ASSERTION_TTL_SECONDS),
    run: brokerRunSchema,
  })
  .strict();
export type BrokerAssertionRequest = z.infer<
  typeof brokerAssertionRequestSchema
>;

/** The broker response; callers must treat `assertion` as an ephemeral secret. */
export const brokerAssertionResponseSchema = z
  .object({
    assertion: z
      .string()
      .regex(/^[^.\s]+\.[^.\s]+\.[^.\s]+$/)
      .max(16_384),
    issuer: z.url({ protocol: /^https$/ }),
    audience: z.string().trim().min(1).max(500),
    subject: z.literal(WORKLOAD_SUBJECT),
    expiresAt: z.iso.datetime({ offset: true }),
    run: brokerRunSchema,
  })
  .strict();
export type BrokerAssertionResponse = z.infer<
  typeof brokerAssertionResponseSchema
>;
