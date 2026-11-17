// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: Apache-2.0

/**
 * The deliberately small, edition-neutral protocol between Alethia Community
 * and an optional extension package. Concrete capabilities stay in their owning
 * package; this module only describes registration, edition selection and the
 * report an extension makes about the instance edition.
 */
export type AlethiaEdition = "community" | "enterprise" | "auto";

export type EnterpriseEntrypoint<TCore, TModule> = (core: TCore) => TModule;

export interface EnterprisePackage<TCore, TModule> {
  register: EnterpriseEntrypoint<TCore, TModule>;
}

export function parseAlethiaEdition(value?: string): AlethiaEdition {
  if (value === undefined || value === "") return "auto";
  if (value === "community" || value === "enterprise" || value === "auto") {
    return value;
  }
  throw new Error(
    `Invalid ALETHIA_EDITION=${value}; expected community, enterprise, or auto.`,
  );
}

// ── The instance edition report ──────────────────────────────────────────────────────────────
//
// What an extension package tells the Community application about the instance it is loaded
// into: the state of the instance licence, the capabilities that licence grants, and which of the
// extension's modules are built. It is the ONE channel for those three answers. The application
// treats everything that arrives through it as untrusted input: `parseEnterpriseEditionReport`
// returns null for any shape it does not recognise, and the reader then answers with Community
// capabilities.

/** Where an instance runs: on the hosted service, or on infrastructure its operator manages. */
export type DeploymentMode = "hosted" | "self-managed";

/**
 * The state of an instance licence.
 *
 * - `none`: no licence is installed.
 * - `active`: a valid licence, not close to its end.
 * - `expiring`: a valid licence that ends soon.
 * - `grace`: the licence has ended and its grace period has not.
 * - `expired`: the licence and its grace period have ended.
 * - `invalid`: a licence is installed and could not be verified.
 */
export type LicenseState =
  | "none"
  | "active"
  | "expiring"
  | "grace"
  | "expired"
  | "invalid";

/** Whether an unknown value is one of the six {@link LicenseState} names. */
export function isLicenseState(value: unknown): value is LicenseState {
  return (
    value === "none" ||
    value === "active" ||
    value === "expiring" ||
    value === "grace" ||
    value === "expired" ||
    value === "invalid"
  );
}

/**
 * Whether a licence in this state grants its capabilities: `active`, `expiring` and `grace` do,
 * every other state does not.
 */
export function licenseStateGrants(state: LicenseState): boolean {
  switch (state) {
    case "active":
    case "expiring":
    case "grace":
      return true;
    case "none":
    case "expired":
    case "invalid":
      return false;
  }
}

/** The instance licence as the extension package reports it. Instants are ISO 8601 strings. */
export interface InstanceLicenseReport {
  state: LicenseState;
  /** Who the licence was issued to, or null when there is none to name. */
  subject: string | null;
  /** The licensed tier, or null when there is none to name. */
  tier: string | null;
  /** When the licence ends, or null for a licence with no end and for no licence. */
  expiresAt: string | null;
  /** When the grace period after `expiresAt` ends, or null when there is none. */
  graceEndsAt: string | null;
}

/**
 * One module of the extension package and whether it is built. A module that is planned and not
 * built is reported with `built: false`, so that a surface can name it without offering it.
 */
export interface EnterpriseFeatureReport {
  id: string;
  built: boolean;
}

/** Everything an extension package reports about the instance it is loaded into. */
export interface EnterpriseEditionReport {
  license: InstanceLicenseReport;
  /**
   * The names of the capabilities the licence grants to the whole instance. The application
   * keeps the names it knows and drops the rest.
   */
  capabilities: readonly string[];
  /** Every module of the extension package, built or not. */
  features: readonly EnterpriseFeatureReport[];
}

/**
 * The optional member a registered extension module carries to report the instance edition. A
 * module without it reports nothing, and the application answers with Community capabilities.
 */
export interface EnterpriseEditionReporter {
  instanceEdition?: () =>
    | EnterpriseEditionReport
    | Promise<EnterpriseEditionReport>;
}

/** Whether an unknown registered module carries the {@link EnterpriseEditionReporter} member. */
export function hasEditionReporter(
  value: unknown,
): value is Required<EnterpriseEditionReporter> {
  return (
    typeof value === "object" &&
    value !== null &&
    "instanceEdition" in value &&
    typeof value.instanceEdition === "function"
  );
}

/** A string-or-null field: `ok` is false for any other type. An absent field reads as null. */
function readNullableString(
  value: unknown,
): { ok: true; value: string | null } | { ok: false } {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (typeof value === "string") return { ok: true, value };
  return { ok: false };
}

/**
 * An instant-or-null field, normalised to ISO 8601. `ok` is false for a value that is not a
 * string or does not parse as a date. An absent field reads as null.
 */
function readNullableInstant(
  value: unknown,
): { ok: true; value: string | null } | { ok: false } {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (typeof value !== "string") return { ok: false };
  const millis = Date.parse(value);
  if (Number.isNaN(millis)) return { ok: false };
  return { ok: true, value: new Date(millis).toISOString() };
}

/** Reads the `license` member of a report, or null when any part of it is not the stated shape. */
function parseLicenseReport(value: unknown): InstanceLicenseReport | null {
  if (typeof value !== "object" || value === null) return null;
  if (!("state" in value)) return null;
  const state: unknown = value.state;
  if (!isLicenseState(state)) return null;
  const subject = readNullableString("subject" in value ? value.subject : null);
  const tier = readNullableString("tier" in value ? value.tier : null);
  const expiresAt = readNullableInstant(
    "expiresAt" in value ? value.expiresAt : null,
  );
  const graceEndsAt = readNullableInstant(
    "graceEndsAt" in value ? value.graceEndsAt : null,
  );
  if (!subject.ok || !tier.ok || !expiresAt.ok || !graceEndsAt.ok) return null;
  return {
    state,
    subject: subject.value,
    tier: tier.value,
    expiresAt: expiresAt.value,
    graceEndsAt: graceEndsAt.value,
  };
}

/** Reads the `capabilities` member: an array of strings, or null for anything else. */
function parseCapabilityNames(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const entries: readonly unknown[] = value;
  const names: string[] = [];
  for (const entry of entries) {
    if (typeof entry !== "string") return null;
    names.push(entry);
  }
  return names;
}

/** Reads the `features` member: an array of `{ id, built }`, or null for anything else. */
function parseFeatureReports(value: unknown): EnterpriseFeatureReport[] | null {
  if (!Array.isArray(value)) return null;
  const entries: readonly unknown[] = value;
  const features: EnterpriseFeatureReport[] = [];
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) return null;
    if (!("id" in entry) || typeof entry.id !== "string" || entry.id === "") {
      return null;
    }
    if (!("built" in entry) || typeof entry.built !== "boolean") return null;
    features.push({ id: entry.id, built: entry.built });
  }
  return features;
}

/**
 * Validates what an extension module returned from `instanceEdition()`. Returns the report with
 * its instants normalised, or null when any part of it is not the stated shape: a report is
 * accepted whole or not at all, so a caller never acts on half of one.
 */
export function parseEnterpriseEditionReport(
  value: unknown,
): EnterpriseEditionReport | null {
  if (typeof value !== "object" || value === null) return null;
  const license = parseLicenseReport("license" in value ? value.license : null);
  const capabilities = parseCapabilityNames(
    "capabilities" in value ? value.capabilities : null,
  );
  const features = parseFeatureReports(
    "features" in value ? value.features : null,
  );
  if (license === null || capabilities === null || features === null) {
    return null;
  }
  return { license, capabilities, features };
}
