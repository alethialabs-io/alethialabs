// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Input validation for the bring-your-own Helm chart attach flow — shared by the attach dialog
// (via zodResolver) and the `attachByoChart` server action, so a field the form accepts is exactly
// a field the action accepts.
//
// A chart arrives one of two ways and they are different shapes, not one shape with an odd URL: a
// GIT chart is a directory in a repo at a ref, an OCI chart is a packaged artifact addressed by one
// `oci://host/ns/chart` URL at a chart version. The schema stays FLAT with a `superRefine` keyed on
// `source` (the convention lib/validations/sso.ts uses for OIDC-vs-SAML) rather than becoming a
// discriminated union, so a wizard step can validate a single field path and switching source
// mid-flow never validates the branch that is no longer on screen.

import { z } from "zod";
import { byoReservedNamespaceMessage } from "@/lib/validations/byo-reserved-namespaces";
import { chartSlug } from "@/lib/validations/names";

/** A git remote — an https:// or git@ address. */
export function isPlausibleGitRepoUrl(url: string): boolean {
	return /^https:\/\/\S+$/.test(url) || /^git@\S+:\S+$/.test(url);
}

/**
 * An `oci://` chart reference. Needs a host AND at least one more segment: the last segment is the
 * CHART NAME (`resolveByoChartInstall` pops it to build the ArgoCD `chart` field), so `oci://ghcr.io`
 * alone would resolve to a nameless chart the Application can't pull.
 */
export function isPlausibleOciChartUrl(url: string): boolean {
	const trimmed = url.trim();
	if (!/^oci:\/\/\S+$/.test(trimmed)) return false;
	return (
		trimmed.slice("oci://".length).replace(/\/+$/, "").split("/").filter(Boolean).length >= 2
	);
}

/** Either shape — what the server accepts as a chart repo. */
export function isPlausibleChartRepoUrl(url: string): boolean {
	return isPlausibleGitRepoUrl(url) || isPlausibleOciChartUrl(url);
}

/**
 * Adds a `namespace` issue when the chart targets a namespace reserved for the platform (#6439).
 * Shared by the form and the attach action so the two refuse exactly the same names; the runner
 * refuses them again at deploy time from the same list.
 */
function refuseReservedNamespace(
	namespace: string | undefined,
	ctx: z.RefinementCtx,
	chartId?: string,
): void {
	const message = namespace
		? (byoReservedNamespaceMessage(namespace) ?? byoNamespacePrefixMessage(namespace, chartId))
		: null;
	if (message) {
		ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["namespace"], message });
	}
}

/** The prefix of a BYO chart's own namespace. Mirrors the Go `byoProjectPrefix`. */
const BYO_CHART_NAMESPACE_PREFIX = "byo-";

/** Kubernetes' cap on a namespace name. */
const NAMESPACE_MAX_LENGTH = 63;

/** FNV-1a 32 of `s`'s UTF-8 bytes, as 8 hex digits. Mirrors Go's `hash/fnv` New32a. */
function fnv1a32Hex(s: string): string {
	let h = 0x811c9dc5;
	for (const byte of new TextEncoder().encode(s)) {
		h ^= byte;
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h.toString(16).padStart(8, "0");
}

/**
 * The namespace a BYO chart deploys into when none of its own is chosen: `byo-<chart id>` (#6446).
 * Past 63 characters it is cut further and ends in `-` + an 8-hex hash of the WHOLE id, so two long
 * ids that share a prefix still get two namespaces. The Go `argocd.ByoChartNamespace` derives the same
 * name; the two are held together by the same table of literal cases on each side (tests/lib/validations/byo-charts-namespace.test.ts and
 * packages/core/argocd/byo_oci_test.go). `chartId` is the add-on id — `chartSlug` of the name.
 */
export function byoChartNamespace(chartId: string): string {
	const full = `${BYO_CHART_NAMESPACE_PREFIX}${chartId}`;
	if (full.length <= NAMESPACE_MAX_LENGTH) return full;
	const suffix = fnv1a32Hex(chartId);
	const head = full.slice(0, NAMESPACE_MAX_LENGTH - suffix.length - 1).replace(/-+$/, "");
	return `${head}-${suffix}`;
}

/**
 * Why `namespace` may not be chosen for the chart `chartId` because of its `byo-` prefix, or `null`.
 * The prefix is reserved for each chart's own derived namespace, so a chart cannot take another's;
 * its own is accepted. An ATTACH-time rule only: the runner accepts a "byo-" namespace a chart stored before it, and refuses
 * one side only of a real collision with another chart's derived name. With no
 * `chartId` (the form, before the id is derived), any `byo-` name is refused: leaving the field
 * blank is how a chart gets its own.
 */
export function byoNamespacePrefixMessage(namespace: string, chartId?: string): string | null {
	if (!namespace.startsWith(BYO_CHART_NAMESPACE_PREFIX)) return null;
	if (chartId !== undefined && namespace === byoChartNamespace(chartId)) return null;
	return `Namespaces starting with “${BYO_CHART_NAMESPACE_PREFIX}” are reserved for the namespace each chart gets by default. Leave it blank to use this chart's, or choose one of your own.`;
}

export const CHART_SOURCES = ["git", "oci"] as const;
export type ChartSource = (typeof CHART_SOURCES)[number];

// `chartSlug` lives in lib/validations/names.ts, beside the ONE slugifier and the add-on id's
// length budget. The copy that was here had no cap at all, and its output becomes an ArgoCD
// Application name via `argocd.AddOnAppName` ("addon-"+id) — a name Kubernetes bounds at 63.

/**
 * The attach form. Optional fields carry their defaults at the EDGE (`ref` → `HEAD`/`*`,
 * `namespace` → `byo-<chart id>`) rather than in the action, so what the review step shows is what
 * gets persisted.
 */
export const byoChartFormSchema = z
	.object({
		source: z.enum(CHART_SOURCES),
		/** The git remote (source=git) or the whole `oci://host/ns/chart` reference (source=oci). */
		repoUrl: z.string().trim().min(1, "A chart source is required"),
		/** Chart directory within a git repo. Unused for OCI — the chart is named by the URL. */
		chartPath: z.string().trim().optional(),
		/** Git ref (source=git) or chart version (source=oci). Blank means the source's default. */
		ref: z.string().trim().optional(),
		/** Display name; blank derives one from the URL's last segment. */
		name: z.string().trim().optional(),
		namespace: z.string().trim().optional(),
		valuesYaml: z.string().optional(),
	})
	.superRefine((value, ctx) => {
		refuseReservedNamespace(value.namespace, ctx);
		if (value.source === "oci") {
			if (!isPlausibleOciChartUrl(value.repoUrl)) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					path: ["repoUrl"],
					message:
						"Enter the whole chart reference — oci://host/namespace/chart, including the chart name.",
				});
			}
			return;
		}
		if (!isPlausibleGitRepoUrl(value.repoUrl)) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["repoUrl"],
				message: "Enter a valid git repository URL (https:// or git@…).",
			});
		}
		// Only the git branch needs a path: without it the runner has a clone and no chart in it.
		if (!value.chartPath) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["chartPath"],
				message: "Enter the chart path within the repository.",
			});
		}
	});

export type ByoChartFormValues = z.infer<typeof byoChartFormSchema>;

/** The `attachByoChart` wire input. `id` is the resolved slug; the form's `name` derives it. */
export const byoChartAttachSchema = z
	.object({
		// Ids are checked for presence only: `authorize` resolves the project under the actor's scope
		// and `resolveActiveEnvironmentId` the environment, so a bogus id fails there with the right
		// error. Shape-checking them here would just duplicate that in a worse place.
		projectId: z.string().min(1),
		environmentId: z.string().min(1).nullish(),
		id: z.string().trim().min(1),
		repoUrl: z
			.string()
			.trim()
			.refine(
				isPlausibleChartRepoUrl,
				"Enter a valid chart repository URL (https://, git@…, or oci://…).",
			),
		chartPath: z.string().trim().optional(),
		ref: z.string().trim().optional(),
		namespace: z.string().trim().optional(),
		valuesYaml: z.string().nullish(),
		gitCredentialId: z.string().min(1).nullish(),
		values: z.record(z.string(), z.unknown()).optional(),
	})
	.superRefine((value, ctx) => {
		// The action is a public entry point (the CLI route calls it too), so the form's refusal is
		// not enough on its own. The id is the one the action stores (`chartSlug`), so a chart's own
		// derived namespace — what the form sends for a blank field — is accepted.
		refuseReservedNamespace(value.namespace, ctx, chartSlug(value.id));
		// Re-checked server-side rather than trusted from the form: the action is a public entry
		// point, and a git chart with no path silently renders an empty Application.
		if (!value.repoUrl.startsWith("oci://") && !value.chartPath?.replace(/^\/+/, "")) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["chartPath"],
				message: "Enter the chart path within the repository.",
			});
		}
	});

export type ByoChartAttachInput = z.infer<typeof byoChartAttachSchema>;
