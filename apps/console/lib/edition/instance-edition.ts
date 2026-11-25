// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The single resolver of the instance edition (types/edition.types.ts). It combines three facts:
// where the instance runs (the deployment mode), which build is running (the outcome of the
// enterprise load), and what the registered enterprise module reports about the licence and its
// own modules. The enterprise package is reached only through the module the loader registered;
// this file never resolves it.
//
// It fails closed. A licence state that was not reported, that could not be read, that is not the
// stated shape or that contradicts its own dates is `unknown`, and `unknown` grants what a
// community instance has. No path through this file turns a missing answer into a capability.
//
// It answers for the INSTANCE. What one organisation may use is still the per-organisation
// entitlements (lib/authz/entitlements.ts); on the hosted service those come from the
// organisation's plan, and this contract says so with `capabilitySource: "organization-plan"`.
// Server-only.

import {
	hasEditionReporter,
	licenseStateGrants,
	parseEnterpriseEditionReport,
	type DeploymentMode,
	type EnterpriseEditionReport,
} from "@alethia/enterprise-api";
import { deploymentMode } from "@/lib/billing/config";
import { editionState, getEnterprise } from "@/lib/enterprise";
import type {
	CapabilitySource,
	EditionDiagnostic,
	InstanceBuild,
	InstanceCapability,
	InstanceEdition,
	InstanceLicense,
	InstanceOffering,
} from "@/types/edition.types";

/**
 * Every capability a licence can grant, in the order surfaces list them. Written as a record so
 * that adding a switch to `Entitlements` without naming it here is a type error.
 */
const CAPABILITY_ORDER: Record<InstanceCapability, number> = {
	organizations: 0,
	teams: 1,
	customRoles: 2,
	sso: 3,
	activityExport: 4,
	alerting: 5,
	advancedAlerting: 6,
	byoRunners: 7,
	managedPools: 8,
	agentPolicy: 9,
};

/** Whether a reported capability name is one this build knows. */
function isInstanceCapability(name: string): name is InstanceCapability {
	return Object.prototype.hasOwnProperty.call(CAPABILITY_ORDER, name);
}

/** The capability list: every capability a licence can grant, in display order. */
export function instanceCapabilities(): InstanceCapability[] {
	const names: InstanceCapability[] = [];
	for (const name of Object.keys(CAPABILITY_ORDER)) {
		if (isInstanceCapability(name)) names.push(name);
	}
	return names.sort((a, b) => CAPABILITY_ORDER[a] - CAPABILITY_ORDER[b]);
}

/** What the enterprise module's report came to: a validated report, or the reason there is none. */
export type EditionReportOutcome =
	| { kind: "report"; report: EnterpriseEditionReport }
	| { kind: "none"; diagnostic: Exclude<EditionDiagnostic, "ok" | "inconsistent-report"> };

/** The facts {@link resolveInstanceEdition} decides from. */
export interface InstanceEditionInputs {
	deployment: DeploymentMode;
	build: InstanceBuild;
	outcome: EditionReportOutcome;
	/** The instant the licence dates are compared against. */
	now: Date;
}

/** The licence a build with no readable report has: the given state and nothing else. */
function licenseWithoutReport(state: "none" | "unknown"): InstanceLicense {
	return { state, subject: null, tier: null, expiresAt: null, graceEndsAt: null };
}

/** Whether an ISO instant is at or before `now`. An instant that does not parse counts as passed. */
function hasPassed(instant: string, now: Date): boolean {
	const millis = Date.parse(instant);
	return Number.isNaN(millis) || millis <= now.getTime();
}

/**
 * Whether a report's licence state agrees with its own dates at `now`. `active` and `expiring`
 * need an end that has not passed, or no end; `grace` needs a grace end that has not passed. The
 * states that grant nothing are never contradicted, because refusing them changes nothing.
 */
function licenseDatesAgree(license: EnterpriseEditionReport["license"], now: Date): boolean {
	switch (license.state) {
		case "active":
		case "expiring":
			return license.expiresAt === null || !hasPassed(license.expiresAt, now);
		case "grace":
			return license.graceEndsAt !== null && !hasPassed(license.graceEndsAt, now);
		case "none":
		case "expired":
		case "invalid":
			return true;
	}
}

/** The capabilities a report names that this build knows, without repeats, in display order. */
function knownCapabilities(names: readonly string[]): InstanceCapability[] {
	const reported = new Set(names);
	return instanceCapabilities().filter((name) => reported.has(name));
}

/** The edition a person would call the instance, from where it runs and whether it is licensed. */
function offeringOf(deployment: DeploymentMode, licensed: boolean): InstanceOffering {
	if (deployment === "hosted") return "hosted";
	return licensed ? "enterprise" : "self-hosted";
}

/**
 * Decides the instance edition from its inputs. Pure: the same inputs give the same answer.
 *
 * The licence grants capabilities only when the build is enterprise, the report was read, its
 * state is one that grants and its dates agree with that state. In every other case the instance
 * grants nothing: on the hosted service running the enterprise build each organisation's plan
 * decides, and everywhere else the answer is community.
 */
export function resolveInstanceEdition(inputs: InstanceEditionInputs): InstanceEdition {
	const { deployment, build, outcome, now } = inputs;

	let license: InstanceLicense;
	let diagnostic: EditionDiagnostic;
	let reportedCapabilities: readonly string[] = [];
	let features: InstanceEdition["features"] = [];

	if (build === "community") {
		// A community build holds no licence. A failed enterprise load arrives here too, with its
		// own diagnostic and a state that says the licence was not read.
		diagnostic = outcome.kind === "none" ? outcome.diagnostic : "ok";
		license = licenseWithoutReport(diagnostic === "ok" ? "none" : "unknown");
	} else if (outcome.kind === "none") {
		diagnostic = outcome.diagnostic;
		license = licenseWithoutReport("unknown");
	} else {
		// The modules are a property of the build, so they are listed whatever the licence says.
		features = outcome.report.features;
		if (licenseDatesAgree(outcome.report.license, now)) {
			diagnostic = "ok";
			license = outcome.report.license;
			reportedCapabilities = outcome.report.capabilities;
		} else {
			diagnostic = "inconsistent-report";
			license = { ...outcome.report.license, state: "unknown" };
		}
	}

	const licensed = license.state !== "unknown" && licenseStateGrants(license.state);

	let capabilitySource: CapabilitySource = "community";
	if (licensed) capabilitySource = "instance-license";
	else if (deployment === "hosted" && build === "enterprise") capabilitySource = "organization-plan";

	return {
		deployment,
		edition: build,
		offering: offeringOf(deployment, licensed),
		license,
		capabilitySource,
		capabilities: licensed ? knownCapabilities(reportedCapabilities) : [],
		features,
		diagnostic,
	};
}

/** What a community build reports: no licence, no capabilities, no enterprise modules. */
const COMMUNITY_REPORT: EnterpriseEditionReport = {
	license: { state: "none", subject: null, tier: null, expiresAt: null, graceEndsAt: null },
	capabilities: [],
	features: [],
};

/**
 * Asks the registered enterprise module for its edition report and validates it. Every way of not
 * getting a valid report is an outcome with a diagnostic, never an exception.
 */
async function readEditionReport(): Promise<EditionReportOutcome> {
	let enterprise: ReturnType<typeof getEnterprise>;
	try {
		enterprise = getEnterprise();
	} catch {
		return { kind: "none", diagnostic: "enterprise-load-failed" };
	}
	if (!hasEditionReporter(enterprise)) return { kind: "none", diagnostic: "no-report" };

	let raw: unknown;
	try {
		raw = await enterprise.instanceEdition();
	} catch {
		return { kind: "none", diagnostic: "report-failed" };
	}
	const report = parseEnterpriseEditionReport(raw);
	if (report === null) return { kind: "none", diagnostic: "malformed-report" };
	return { kind: "report", report };
}

/**
 * The instance edition: where this instance runs, which build it is, the state of its licence,
 * the capabilities that licence grants and the enterprise modules the build contains. The one
 * reader for those answers; it never throws, and a failure to read any part of them yields the
 * community answer with a diagnostic naming the part.
 */
export async function getInstanceEdition(now: Date = new Date()): Promise<InstanceEdition> {
	const deployment = deploymentMode();
	const state = editionState();
	if (state.kind === "community") {
		return resolveInstanceEdition({
			deployment,
			build: "community",
			outcome: { kind: "report", report: COMMUNITY_REPORT },
			now,
		});
	}
	if (state.kind === "failed") {
		return resolveInstanceEdition({
			deployment,
			build: "community",
			outcome: { kind: "none", diagnostic: "enterprise-load-failed" },
			now,
		});
	}
	return resolveInstanceEdition({
		deployment,
		build: "enterprise",
		outcome: await readEditionReport(),
		now,
	});
}
