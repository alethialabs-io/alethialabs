// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Types for the cluster add-on marketplace — free OSS apps (Grafana, Vault, Trivy, …) the
// customer's provisioned cluster comes up with, deployed as ArgoCD Helm Applications. The
// catalog (catalog.ts) is a code SSOT (no DB enum) modelled on lib/alerts/catalog.ts; the
// console resolves an enabled add-on into a fully-resolved install spec (chart coords +
// merged Helm values + mode) that rides the DEPLOY job's config snapshot to the runner.

import { z } from "zod";

/** Day-2 categories an add-on belongs to (drives grouping in the marketplace UI). */
export type AddOnCategory =
	| "observability"
	| "security"
	| "secrets"
	| "networking"
	| "platform"
	| "autoscaling"
	| "backup"
	| "policy"
	| "data";

/** How an add-on is delivered into the cluster. `managed` = Alethia renders + applies the
 * ArgoCD Application directly; `gitops` = the manifest is written into the customer's apps
 * repo and ArgoCD syncs it from there (they own + edit it). Mirrors the `addon_mode` enum. */
export type AddOnMode = "managed" | "gitops";

/** lucide icon name the UI resolves — data stays JSX-free (mirrors the alerts catalog). */
export type AddOnIcon =
	| "LineChart"
	| "ScrollText"
	| "ShieldCheck"
	| "KeyRound"
	| "Network"
	| "Boxes"
	| "Gauge"
	| "Archive"
	| "Database"
	| "Lock";

/** A capability an add-on expects the environment to provide (informational gating). */
export type AddOnRequirement = "ingress" | "domain" | "storage";

/** The kind of a configurable add-on knob. `enum` = a fixed choice (carries `options`); `secret`
 * = a credential persisted encrypted-at-rest (EncryptedSecret), never plaintext; `nested` = a
 * one-level group of scalar sub-fields (e.g. `resources.requests.{cpu,memory}`). */
export type AddOnFieldType =
	| "number"
	| "boolean"
	| "string"
	| "enum"
	| "secret"
	| "nested";

/** A serializable descriptor for one configurable knob — drives the configure form on the
 * client (the Zod `configSchema` still validates server-side; this mirrors its fields). Validate a
 * descriptor with `addOnFieldSchema` (W4 adds the descriptor↔schema consistency guard). */
export interface AddOnField {
	key: string;
	label: string;
	type: AddOnFieldType;
	/** Default for a scalar field. Omitted for `secret` (write-only) and `nested` (its children
	 * carry their own defaults). */
	default?: number | boolean | string;
	help?: string;
	min?: number;
	max?: number;
	/** Fixed choices for `type: "enum"` — the `value` is stored, the `label` is shown. */
	options?: { value: string; label: string }[];
	/** Child descriptors for `type: "nested"` — ONE level only (children must be scalar). */
	fields?: AddOnField[];
	/** Convenience flag equal to `type === "secret"` — persisted encrypted-at-rest, never plaintext. */
	secret?: boolean;
}

const addOnFieldOption = z.object({ value: z.string(), label: z.string() });

/** Fields common to every descriptor kind. */
const addOnFieldBase = {
	key: z.string().min(1),
	label: z.string().min(1),
	help: z.string().optional(),
	min: z.number().optional(),
	max: z.number().optional(),
};

/** A scalar (non-nested) descriptor. An `enum` must carry non-empty `options`. */
const addOnScalarFieldSchema = z
	.object({
		...addOnFieldBase,
		type: z.enum(["number", "boolean", "string", "enum", "secret"]),
		default: z.union([z.number(), z.boolean(), z.string()]).optional(),
		options: z.array(addOnFieldOption).optional(),
		secret: z.boolean().optional(),
	})
	.refine((f) => f.type !== "enum" || (f.options?.length ?? 0) > 0, {
		message: "an enum field requires non-empty options",
		path: ["options"],
	});

/** Validates one `AddOnField` descriptor: a scalar kind, or a one-level `nested` group whose
 * children are scalars (no deeper recursion — a deliberate W4 constraint). */
export const addOnFieldSchema = z.union([
	addOnScalarFieldSchema,
	z.object({
		...addOnFieldBase,
		type: z.literal("nested"),
		fields: z.array(addOnScalarFieldSchema).min(1),
	}),
]);

/**
 * A catalog entry: a curated OSS Helm chart plus the small set of user-tunable knobs the
 * marketplace surfaces. `configSchema` validates the knobs; `toValues` maps the parsed knobs
 * to a partial Helm-values object that is deep-merged onto `defaultValues`.
 */
export interface AddOnDef<Schema extends z.ZodTypeAny = z.ZodTypeAny> {
	/** Stable catalog id, e.g. "kube-prometheus-stack" (the `project_addons.addon_id`). */
	id: string;
	name: string;
	category: AddOnCategory;
	icon: AddOnIcon;
	/** One-line description shown on the card. */
	summary: string;
	docsUrl: string;
	/** OSS license label (e.g. "Apache-2.0"). Every catalog add-on is free. */
	license: string;
	// ── Helm coordinates ────────────────────────────────────────────────
	chartRepo: string;
	chart: string;
	/** Pinned chart version (the install default; a row may override it). */
	version: string;
	/** Default install namespace. */
	namespace: string;
	/** Base Helm values always applied, before the user knobs are merged in. */
	defaultValues?: Record<string, unknown>;
	/** Zod schema for the surfaced knobs (with defaults) — drives the configure form. */
	configSchema: Schema;
	/** Maps the parsed knobs to a partial Helm-values object (deep-merged onto defaults). */
	toValues?: (config: z.infer<Schema>) => Record<string, unknown>;
	/** Serializable descriptors for the surfaced knobs (mirror `configSchema`) — drive the
	 * client configure form. Empty for add-ons with no knobs. */
	fields: AddOnField[];
	/** ArgoCD sync-wave ordering (lower installs first). */
	syncWave: number;
	/** Capabilities this add-on expects (surfaced as hints in the UI). */
	requires?: AddOnRequirement[];
}

/**
 * A fully-resolved install spec — the runner-facing shape written into the DEPLOY job's
 * config snapshot (mirrors the Go `types.AddOnInstall`). The runner renders one ArgoCD
 * Application per spec; it needs no catalog of its own.
 */
export interface AddOnInstallSpec {
	id: string;
	mode: AddOnMode;
	chartRepo: string;
	chart: string;
	version: string;
	/** How the add-on is delivered. Omitted / "helm" = a Helm-registry chart (chartRepo+chart);
	 * "git" = a bring-your-own chart directory inside a git repo (chartRepo=git URL, path=chart
	 * dir, version=git ref); "manifest" = a plain YAML manifest the RUNNER kubectl-applies
	 * (chartRepo = the PINNED manifest URL, version = the release tag) — the operator rail, for
	 * operators that ship as `kubectl apply` release manifests rather than charts (an ArgoCD
	 * Application source cannot be a bare https://…yaml). Manifest add-ons get NO ArgoCD
	 * Application and install BEFORE the chart Applications. Mirrors the Go `AddOnInstall.Source`. */
	source?: "helm" | "git" | "manifest";
	/** Chart directory within a git-source repo (source==="git"). Omitted for Helm charts. */
	path?: string;
	/** CRD names a manifest-source add-on establishes (e.g. "rabbitmqclusters.rabbitmq.com"). The
	 * runner waits for each to reach condition=Established after applying, so a CR can't be synced
	 * before the operator that owns its schema exists. Omitted for helm/git sources. */
	crds?: string[];
	/** ArgoCD AppProject the Application is placed in. Omitted = "infra" (marketplace default);
	 * BYO charts are pinned to their hardened "byo-<slug>" project by the runner. */
	project?: string;
	namespace: string;
	/** Fully-merged Helm values (defaults + user knobs, or a raw override in gitops mode). */
	values: Record<string, unknown>;
	syncWave: number;
}
