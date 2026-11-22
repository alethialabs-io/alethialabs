// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// What the create screen works out for the person, so they are asked only what cannot be worked out.
//
// Every value here is a DEFAULT the screen shows in an editable field, never a decision made behind
// the person's back. Each answer also says where it came from, so the screen can say so in a word
// ("Nearest to you", "Where your other AWS projects run").
//
// Pure functions over plain data: no React, no query, no clock. The screen reads the data (the
// connectors list, the org's projects, the scan, the browser's time zone) and passes it in.

import type { ConnectorWithConnection } from "@/app/server/actions/connectors";
import { DEFAULT_REGION, REGION_LABELS, type CloudProviderSlug } from "@/lib/cloud-providers";
import { isCloudProviderSlug } from "@/lib/cloud-providers/provider-slug";
import { pickFreeProjectName } from "@/lib/validations/project-form.schema";

/** One cloud account the org holds, as the create screen offers it. */
export interface AccountOption {
	readonly identityId: string;
	readonly provider: CloudProviderSlug;
	readonly name: string;
	/** Account id, project or subscription, when the connector reports one. */
	readonly label: string | null;
	/** True when the account verified and can take a new project (connected or degraded). */
	readonly usable: boolean;
}

/** A connected cloud this deployment does not offer for new projects. */
export interface UnofferedCloud {
	readonly slug: string;
	readonly name: string;
}

/** What the org's existing projects say, for the deductions that read them. */
export interface ExistingProject {
	readonly project_name: string;
	readonly region: string;
	readonly cloud_provider: string | null;
}

/**
 * The accounts on the offered clouds, in the connectors list's order, and the connected clouds
 * that are not offered (shown with the reason, never as a choice).
 */
export function cloudAccounts(
	integrations: readonly Pick<ConnectorWithConnection, "slug" | "name" | "category" | "connected" | "accounts">[],
	offered: readonly CloudProviderSlug[],
): { accounts: AccountOption[]; unoffered: UnofferedCloud[] } {
	const accounts: AccountOption[] = [];
	const unoffered: UnofferedCloud[] = [];
	for (const integration of integrations) {
		if (integration.category !== "cloud") continue;
		const slug = integration.slug;
		const isOffered = isCloudProviderSlug(slug) && offered.includes(slug);
		if (!isOffered) {
			if (integration.connected) unoffered.push({ slug, name: integration.name });
			continue;
		}
		for (const account of integration.accounts ?? []) {
			accounts.push({
				identityId: account.identityId,
				provider: slug,
				name: account.name,
				label: account.label ?? null,
				usable: account.status === "connected" || account.status === "degraded",
			});
		}
	}
	return { accounts, unoffered };
}

/** The first usable account on `provider`, or `""` when there is none. */
export function pickAccount(provider: CloudProviderSlug, accounts: readonly AccountOption[]): string {
	return accounts.find((a) => a.provider === provider && a.usable)?.identityId ?? "";
}

/** The value seen most often in `values`, the earliest on a tie; `null` for an empty list. */
function mostCommon<T>(values: readonly T[]): T | null {
	const counts = new Map<T, number>();
	let best: T | null = null;
	let bestCount = 0;
	for (const value of values) {
		const count = (counts.get(value) ?? 0) + 1;
		counts.set(value, count);
		if (count > bestCount) {
			best = value;
			bestCount = count;
		}
	}
	return best;
}

/** Where a deduced cloud came from. */
export type ProviderReason = "scan" | "account" | "projects" | "default";

/**
 * The cloud to start on: the scan's, else the cloud of the first usable account, else the cloud
 * most of the org's projects run on, else the first offered cloud.
 */
export function deduceProvider(args: {
	readonly offered: readonly CloudProviderSlug[];
	readonly scanProvider: CloudProviderSlug | null;
	readonly accounts: readonly AccountOption[];
	readonly projects: readonly ExistingProject[];
}): { provider: CloudProviderSlug; reason: ProviderReason } {
	const { offered, scanProvider, accounts, projects } = args;
	if (scanProvider !== null && offered.includes(scanProvider)) {
		return { provider: scanProvider, reason: "scan" };
	}
	const account = accounts.find((a) => a.usable && offered.includes(a.provider));
	if (account) return { provider: account.provider, reason: "account" };
	const used = mostCommon(
		projects
			.map((p) => p.cloud_provider)
			.filter((p): p is CloudProviderSlug => p !== null && isCloudProviderSlug(p) && offered.includes(p)),
	);
	if (used !== null) return { provider: used, reason: "projects" };
	return { provider: offered[0] ?? "aws", reason: "default" };
}

/** The catalog's region groups a time zone can be placed in. */
export type RegionGroup = "Europe" | "United States" | "South America" | "Asia Pacific";

/** Time zones under `America/` that are in South America. */
const SOUTH_AMERICA = [
	"America/Sao_Paulo",
	"America/Argentina",
	"America/Buenos_Aires",
	"America/Santiago",
	"America/Bogota",
	"America/Lima",
	"America/Caracas",
	"America/Montevideo",
	"America/Asuncion",
	"America/La_Paz",
	"America/Guayaquil",
];

/**
 * The region group nearest to an IANA time zone, or `null` when the zone says nothing about where
 * the person is (`UTC`, `Etc/…`, an empty string).
 */
export function regionGroupForTimeZone(timeZone: string): RegionGroup | null {
	if (timeZone.startsWith("Europe/") || timeZone.startsWith("Africa/") || timeZone.startsWith("Atlantic/")) {
		return "Europe";
	}
	if (SOUTH_AMERICA.some((zone) => timeZone === zone || timeZone.startsWith(`${zone}/`))) {
		return "South America";
	}
	if (
		timeZone.startsWith("America/") ||
		timeZone.startsWith("US/") ||
		timeZone.startsWith("Canada/") ||
		timeZone === "Pacific/Honolulu"
	) {
		return "United States";
	}
	if (
		timeZone.startsWith("Asia/") ||
		timeZone.startsWith("Australia/") ||
		timeZone.startsWith("Pacific/") ||
		timeZone.startsWith("Indian/")
	) {
		return "Asia Pacific";
	}
	return null;
}

/** The cloud's region in `group`: its default region when that is in the group, else the group's first. */
function regionInGroup(provider: CloudProviderSlug, group: RegionGroup): string | null {
	const labels = REGION_LABELS[provider] ?? {};
	const fallback = DEFAULT_REGION[provider];
	if (labels[fallback]?.group === group) return fallback;
	return Object.entries(labels).find(([, meta]) => meta.group === group)?.[0] ?? null;
}

/** Where a deduced region came from. */
export type RegionReason = "scan" | "projects" | "location" | "default";

/**
 * The region to start on, for `provider`: the scan's, else the region most of the org's projects
 * on that cloud use, else the cloud's region nearest the person's time zone, else its default.
 */
export function deduceRegion(args: {
	readonly provider: CloudProviderSlug;
	readonly scanRegion: string | null;
	readonly projects: readonly ExistingProject[];
	readonly timeZone: string;
}): { region: string; reason: RegionReason } {
	const { provider, scanRegion, projects, timeZone } = args;
	const known = REGION_LABELS[provider] ?? {};
	if (scanRegion && Object.hasOwn(known, scanRegion)) return { region: scanRegion, reason: "scan" };
	const used = mostCommon(
		projects
			.filter((p) => p.cloud_provider === provider && Object.hasOwn(known, p.region))
			.map((p) => p.region),
	);
	if (used !== null) return { region: used, reason: "projects" };
	const group = regionGroupForTimeZone(timeZone);
	const near = group === null ? null : regionInGroup(provider, group);
	if (near !== null) return { region: near, reason: "location" };
	return { region: DEFAULT_REGION[provider], reason: "default" };
}

/** The repository's name from its URL (`github.com/acme/api.git` → `api`), or `null`. */
export function repoName(url: string | null | undefined): string | null {
	if (!url) return null;
	const last = url.replace(/\/+$/, "").split("/").pop() ?? "";
	const name = last.replace(/\.git$/, "");
	return name === "" ? null : name;
}

/**
 * The project name to start with: the scan's, else the repository's, else `my-first-project` for
 * an org with no project yet and `my-project` otherwise — made free against the org's names.
 */
export function deduceName(args: {
	readonly scanName: string | null;
	readonly repoUrl: string | null;
	readonly existingNames: readonly string[];
}): string {
	const { scanName, repoUrl, existingNames } = args;
	const base =
		(scanName && scanName.trim()) ||
		repoName(repoUrl) ||
		(existingNames.length === 0 ? "my-first-project" : "my-project");
	return pickFreeProjectName(base, [...existingNames]);
}
