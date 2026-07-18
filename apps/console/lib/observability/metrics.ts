// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The console's OpenTelemetry metric set. Instruments are read from the GLOBAL meter
// (registered by startOtel); when no OTLP endpoint is configured the global meter is
// the API's no-op, so every record() here is a cheap no-op — no telemetry, no cost.
//
// CARDINALITY RULE (the #1 OTel footgun): metric labels are LOW-cardinality only —
// provider / outcome / action / job_type. NEVER a job_id, trace_id, env_id, org_id,
// or runner_id (those are unbounded — they live on SPANS and LOGS, not metric labels).

import { type Attributes, metrics } from "@opentelemetry/api";
import type { ProvisionJobType } from "@/lib/db/schema/enums";

/** The provisioning outcome dimension — a fixed, low-cardinality set. */
export type ProvisionOutcome = "success" | "fail" | "cancel";

/** A fleet scaler action — a fixed, low-cardinality set. */
export type ScalerAction = "create" | "drain" | "destroy";

/**
 * Lazily-built instrument set. Built on first use — AFTER startOtel has registered the
 * global meter provider (register runs at server start, before any claim/scaler tick) —
 * so the instruments bind to the real provider when telemetry is on, or to the no-op
 * meter when it is off. Memoized so we create each instrument exactly once.
 */
function buildInstruments() {
	const meter = metrics.getMeter("alethia-console");
	return {
		/** QUEUED backlog per provider (a point-in-time gauge, sampled each scaler tick). */
		queueDepth: meter.createGauge("alethia.fleet.queue_depth", {
			description: "QUEUED provisioning jobs awaiting a runner, per provider",
			unit: "{job}",
		}),
		/** Online managed runners per provider (sampled each scaler tick). */
		fleetSize: meter.createGauge("alethia.fleet.size", {
			description: "Online managed runners, per provider",
			unit: "{runner}",
		}),
		/** Fleet scaler actions taken, per provider + action (create/drain/destroy). */
		scalerActions: meter.createCounter("alethia.fleet.scaler_actions", {
			description: "Fleet scaler actions applied, by action type",
			unit: "{action}",
		}),
		/** Time a job waited in QUEUED before a runner claimed it, per provider. */
		claimLatency: meter.createHistogram("alethia.job.claim_latency", {
			description: "Seconds a job waited from enqueue to claim",
			unit: "s",
		}),
		/** End-to-end provision execution time, per provider + job_type + outcome. */
		provisionDuration: meter.createHistogram("alethia.provision.duration", {
			description: "Seconds from claim to terminal status",
			unit: "s",
		}),
		/** Terminal provision count, per provider + job_type + outcome. */
		provisionTotal: meter.createCounter("alethia.provision.total", {
			description: "Provisioning jobs reaching a terminal status",
			unit: "{job}",
		}),
	};
}

type Instruments = ReturnType<typeof buildInstruments>;
let instruments: Instruments | undefined;

/** Returns the memoized instrument set (built on first call). */
function inst(): Instruments {
	if (!instruments) instruments = buildInstruments();
	return instruments;
}

/** Normalizes a possibly-null provider to a bounded label value. */
function providerLabel(provider: string | null | undefined): string {
	return provider && provider.length > 0 ? provider : "unknown";
}

/** Maps a terminal job status to the low-cardinality outcome dimension. */
export function outcomeFromStatus(status: string): ProvisionOutcome {
	if (status === "SUCCESS") return "success";
	if (status === "CANCELLED") return "cancel";
	return "fail";
}

/** Records the QUEUED backlog for a provider (fleet controller tick). */
export function recordQueueDepth(
	provider: string | null | undefined,
	depth: number,
): void {
	inst().queueDepth.record(depth, { provider: providerLabel(provider) });
}

/** Records the count of online runners for a provider (fleet controller tick). */
export function recordFleetSize(
	provider: string | null | undefined,
	size: number,
): void {
	inst().fleetSize.record(size, { provider: providerLabel(provider) });
}

/** Increments the scaler-action counter for a provider + action type. */
export function recordScalerAction(
	provider: string | null | undefined,
	action: ScalerAction,
): void {
	inst().scalerActions.add(1, { provider: providerLabel(provider), action });
}

/** Records enqueue→claim latency (seconds) for a provider. */
export function recordClaimLatency(
	provider: string | null | undefined,
	seconds: number,
): void {
	if (!(seconds >= 0)) return; // guard against clock skew / bad timestamps
	inst().claimLatency.record(seconds, { provider: providerLabel(provider) });
}

/**
 * Records a terminal provision: both the duration histogram and the outcome counter,
 * labelled by the low-cardinality provider / job_type / outcome triple.
 */
export function recordProvision(args: {
	provider: string | null | undefined;
	jobType: ProvisionJobType;
	outcome: ProvisionOutcome;
	seconds: number;
}): void {
	const labels: Attributes = {
		provider: providerLabel(args.provider),
		job_type: args.jobType,
		outcome: args.outcome,
	};
	if (args.seconds >= 0) inst().provisionDuration.record(args.seconds, labels);
	inst().provisionTotal.add(1, labels);
}
