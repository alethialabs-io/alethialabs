// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The instance edition contract: the one typed answer to "which edition is this instance, which
// capabilities does it hold for everyone on it, and which enterprise modules are built". The
// reader is `getInstanceEdition()` in lib/edition/instance-edition.ts; every surface that needs
// one of those answers reads it there. Types only, so a client component may import this file.

import type {
	DeploymentMode,
	EnterpriseFeatureReport,
	LicenseState,
} from "@alethia/enterprise-api";
import type { Entitlements } from "@/lib/authz/types";

/** The build that is running: with the enterprise package registered, or without it. */
export type InstanceBuild = "community" | "enterprise";

/**
 * The edition a person would call this instance.
 *
 * - `hosted`: the hosted service.
 * - `enterprise`: a self-managed instance running the enterprise build under a licence that
 *   grants its capabilities.
 * - `self-hosted`: every other self-managed instance. That includes the enterprise build with no
 *   licence, with a licence that has ended, and with a licence whose state could not be read.
 */
export type InstanceOffering = "hosted" | "self-hosted" | "enterprise";

/**
 * The licence state the contract carries: the six states the enterprise package reports, and
 * `unknown` for a state that was not reported or could not be read. `unknown` grants nothing.
 */
export type InstanceLicenseState = LicenseState | "unknown";

/** The instance licence. Instants are ISO 8601 strings. */
export interface InstanceLicense {
	state: InstanceLicenseState;
	/** Who the licence was issued to, or null. */
	subject: string | null;
	/** The licensed tier, or null. */
	tier: string | null;
	/** When the licence ends, or null for a licence with no end and for no licence. */
	expiresAt: string | null;
	/** When the grace period after `expiresAt` ends, or null. */
	graceEndsAt: string | null;
}

/**
 * A capability an instance licence can grant to everyone on the instance: each switch of
 * {@link Entitlements}. The quotas are not capabilities and are not listed.
 */
export type InstanceCapability = Exclude<keyof Entitlements, "quotas">;

/**
 * What decides the capabilities on this instance.
 *
 * - `instance-license`: the licence grants {@link InstanceEdition.capabilities} to every
 *   organisation on the instance.
 * - `organization-plan`: the instance grants nothing by itself; each organisation's plan
 *   decides, and the per-organisation entitlements are the answer.
 * - `community`: the instance grants nothing.
 */
export type CapabilitySource = "community" | "instance-license" | "organization-plan";

/**
 * Why the reader answered the way it did. Anything other than `ok` means the enterprise
 * package's report was not used and the answer is the one a community instance gets.
 *
 * - `ok`: a community build, or an enterprise build whose report was read.
 * - `enterprise-load-failed`: the instance is configured as enterprise and the package failed
 *   to load.
 * - `no-report`: the registered enterprise module does not report the edition.
 * - `report-failed`: asking the module for its report threw.
 * - `malformed-report`: the report was not the stated shape.
 * - `inconsistent-report`: the report's licence state contradicts its own dates.
 */
export type EditionDiagnostic =
	| "ok"
	| "enterprise-load-failed"
	| "no-report"
	| "report-failed"
	| "malformed-report"
	| "inconsistent-report";

/** One enterprise module and whether this build contains it. */
export type InstanceFeature = EnterpriseFeatureReport;

/** The instance edition: deployment, build, licence, capabilities and built modules. */
export interface InstanceEdition {
	deployment: DeploymentMode;
	edition: InstanceBuild;
	offering: InstanceOffering;
	license: InstanceLicense;
	capabilitySource: CapabilitySource;
	/** The capabilities the instance licence grants. Empty unless the source is the licence. */
	capabilities: readonly InstanceCapability[];
	/** Every enterprise module the build names, built or not. Empty on a community build. */
	features: readonly InstanceFeature[];
	diagnostic: EditionDiagnostic;
}
