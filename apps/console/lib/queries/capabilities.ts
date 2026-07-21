// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import "server-only";

// Read builder for the per-tenant capabilities catalog (epic #928 / wave:capabilities). The design-canvas
// pickers read THIS account's launchable regions + instance types here, with FAIL-OPEN fallback to the
// static Catalog #2 (lib/cloud-providers/{regions,compute}.ts) whenever the account has no synced rows
// (fresh connect / sync error) — so the picker is never empty.
//
// SECURITY: unlike lib/queries/runner-capabilities.ts (platform-internal, getServiceDb + RLS-bypass),
// these are TENANT reads — they run PDP-gated under withActorScope so the programmables.sql RLS actually
// enforces cross-tenant isolation (a caller can only read capabilities for a cloud_identity they
// own/share), and every query also filters `provider` (the cross-provider-leak rule). `launchable` /
// `launchable_reason` are BOUNDED enums; render them as escaped text, never dangerouslySetInnerHTML.

import { and, eq, isNull } from "drizzle-orm";
import { authorize } from "@/lib/authz/guard";
import { withActorScope } from "@/lib/db";
import {
	cloudCapabilityInstanceTypes,
	cloudCapabilityRegions,
} from "@/lib/db/schema";
import { INSTANCE_TYPES } from "@/lib/cloud-providers/compute";
import { REGION_LABELS } from "@/lib/cloud-providers/regions";
import type { CloudProviderSlug } from "@/lib/cloud-providers/registry";
import type {
	CapabilityLaunchable,
	CapabilityLaunchableReason,
} from "@/lib/db/schema";

/** An instance-type option the pickers consume — the static Catalog #2 shape plus the account-accurate
 * tri-state verdict (absent when the row is a static fallback). */
export interface CapabilityInstanceOption {
	value: string;
	label: string;
	vcpu: number | null;
	memoryGb: number | null;
	/** Rough monthly cost (static-catalog rows only; null for federated rows). */
	cost?: string;
	/** Account-accurate launch verdict. `undefined` ⇒ static fallback (no per-account signal). */
	launchable?: CapabilityLaunchable;
	launchableReason?: CapabilityLaunchableReason | null;
}

/**
 * The region CODES this account can deploy to. Fails open to the static catalog's full region set for
 * the provider when nothing has synced yet. The picker groups these via `groupRegions(codes, provider)`.
 */
export async function getRegionCapabilities(
	cloudIdentityId: string,
	provider: CloudProviderSlug,
): Promise<string[]> {
	const actor = await authorize("view", {
		type: "cloud_identity",
		id: cloudIdentityId,
	});
	const rows = await withActorScope(actor, (tx) =>
		tx
			.select({ code: cloudCapabilityRegions.native_id })
			.from(cloudCapabilityRegions)
			.where(
				and(
					eq(cloudCapabilityRegions.cloud_identity_id, cloudIdentityId),
					eq(cloudCapabilityRegions.provider, provider),
					isNull(cloudCapabilityRegions.removed_at),
				),
			)
			.orderBy(cloudCapabilityRegions.native_id),
	);
	if (rows.length > 0) return rows.map((r) => r.code);
	// Fail-open: the static catalog's full region set for this provider.
	return Object.keys(REGION_LABELS[provider] ?? {});
}

/**
 * The instance/machine/server types this account can launch — optionally scoped to a region. Fails open
 * to the static catalog's per-provider list (which carries no per-account `launchable` signal) when
 * nothing has synced yet. Availability is GUIDANCE — the picker renders `not_launchable`/`not_evaluable`
 * as advisory, never a hard gate.
 */
export async function getInstanceTypeCapabilities(
	cloudIdentityId: string,
	provider: CloudProviderSlug,
	region?: string,
): Promise<CapabilityInstanceOption[]> {
	const actor = await authorize("view", {
		type: "cloud_identity",
		id: cloudIdentityId,
	});
	const rows = await withActorScope(actor, (tx) =>
		tx
			.select({
				value: cloudCapabilityInstanceTypes.native_id,
				name: cloudCapabilityInstanceTypes.name,
				vcpu: cloudCapabilityInstanceTypes.vcpu,
				memGb: cloudCapabilityInstanceTypes.mem_gb,
				launchable: cloudCapabilityInstanceTypes.launchable,
				launchableReason: cloudCapabilityInstanceTypes.launchable_reason,
			})
			.from(cloudCapabilityInstanceTypes)
			.where(
				and(
					eq(cloudCapabilityInstanceTypes.cloud_identity_id, cloudIdentityId),
					eq(cloudCapabilityInstanceTypes.provider, provider),
					isNull(cloudCapabilityInstanceTypes.removed_at),
					region
						? eq(cloudCapabilityInstanceTypes.region, region)
						: undefined,
				),
			)
			.orderBy(cloudCapabilityInstanceTypes.native_id),
	);
	if (rows.length > 0) {
		return rows.map((r) => ({
			value: r.value,
			label: r.name ?? r.value,
			vcpu: r.vcpu,
			memoryGb: r.memGb,
			launchable: r.launchable,
			launchableReason: r.launchableReason,
		}));
	}
	// Fail-open: the static catalog for this provider (no per-account launch verdict).
	return (INSTANCE_TYPES[provider] ?? []).map((it) => ({
		value: it.value,
		label: it.label,
		vcpu: it.vcpu,
		memoryGb: it.memoryGb,
		cost: it.cost,
	}));
}
