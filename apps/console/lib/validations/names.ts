// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The name grammars both surfaces are held to (#3665) — the console form, the CLI routes, the
// server actions, and (through apps/console/scripts/gen-go-names.ts) `packages/core/names` in Go.
//
// Two grammars, and they are deliberately different KINDS of rule:
//
//   NAMESPACE is a Kubernetes object name the operator typed. It is REFUSED, never repaired,
//   and the rule is Kubernetes' own DNS-1123 label: `^[a-z0-9]([-a-z0-9]*[a-z0-9])?$`, ≤63.
//   The console's own rule was `^[a-z]([a-z0-9-]*[a-z0-9])?$` and the CLI route's was
//   `^[a-z][a-z0-9-]*$` — so `1dev` was refused although Kubernetes accepts it, and `dev-` was
//   ACCEPTED by the CLI although Kubernetes does not, which is a deploy that dies at apply time
//   naming a namespace instead of a name. Refuse only what is genuinely broken.
//
//   ENVIRONMENT NAME is a product name the user typed. It is NORMALIZED — slugified — because
//   that is what `project env add Prod` has always done, while `project create --env Prod:...`
//   400'd on a regex against the raw name. Two creation paths, one answer: slugify. What it
//   still refuses is the pair of things normalising cannot fix — a name that slugs away to
//   nothing, and a name that collides with a reserved console route (an environment called
//   `settings` gets a URL permanently shadowed by /{org}/{project}/settings).

import { z } from "zod";

import { RESERVED_PROJECT_CHILD_SLUGS } from "@/lib/routing";
import { SLUG_MAX_LENGTH, slugifyOrEmpty } from "@/lib/utils/slugify";

/** Kubernetes' DNS-1123 label grammar, as a RE2-compatible source string.
 *  Exported as a string (not only as a RegExp) because gen-go-names.ts emits this exact text
 *  into Go — one grammar, two languages, no transcription. */
export const DNS1123_LABEL_PATTERN_SOURCE = "^[a-z0-9]([-a-z0-9]*[a-z0-9])?$";

/** Kubernetes' DNS-1123 label grammar: lowercase alphanumerics and `-`, alphanumeric at both ends. */
export const DNS1123_LABEL_PATTERN = new RegExp(DNS1123_LABEL_PATTERN_SOURCE);

/** The DNS-1123 label length limit — a Kubernetes Namespace name, and every slug. */
export const DNS1123_LABEL_MAX_LENGTH = SLUG_MAX_LENGTH;

/** Whether `value` is exactly what Kubernetes accepts as a Namespace name. */
export function isDns1123Label(value: string): boolean {
	return (
		value.length > 0 &&
		value.length <= DNS1123_LABEL_MAX_LENGTH &&
		DNS1123_LABEL_PATTERN.test(value)
	);
}

/** Why `value` is not a legal Kubernetes namespace, or `null` when it is one. The message names
 *  the rule Kubernetes applies, because the alternative is finding out at apply time. */
export function namespaceProblem(value: string): string | null {
	if (value.length === 0) return "Namespace is required";
	if (value.length > DNS1123_LABEL_MAX_LENGTH)
		return `Namespace is ${value.length} characters; Kubernetes allows at most ${DNS1123_LABEL_MAX_LENGTH}`;
	if (!DNS1123_LABEL_PATTERN.test(value))
		return "Namespace must be lowercase letters, digits or '-', and must start and end with a letter or digit";
	return null;
}

/** A Kubernetes namespace. Refused, not repaired — see the module comment. */
export const namespaceSchema = z.string().superRefine((value, ctx) => {
	const problem = namespaceProblem(value);
	if (problem) ctx.addIssue({ code: "custom", message: problem });
});

/** The slug cap for an environment name. Shorter than a DNS-1123 label because the env name is a
 *  SEGMENT of longer derived names (the tofu state path, the Fabric name, `tenant-<project>-<ns>`),
 *  and it was already 40 in the console form. */
export const ENVIRONMENT_NAME_MAX_LENGTH = 40;

/** The longest raw name the env-name schema will look at. Not a grammar rule — a bound on the
 *  input, so a megabyte of text is refused rather than silently slugged down to 40 characters. */
export const ENVIRONMENT_NAME_INPUT_MAX_LENGTH = 200;

/** Environment names that would be permanently shadowed by a console route: `/{org}/{project}/settings`
 *  wins over an environment called `settings`. Same list the project drilldown reserves, so the two
 *  cannot drift. */
export const RESERVED_ENVIRONMENT_NAMES: readonly string[] = RESERVED_PROJECT_CHILD_SLUGS;

/** The canonical form of an environment name — the slug that gets stored. `""` when the name slugs
 *  away entirely; `environmentNameProblem` is what turns that into a message. */
export function normalizeEnvironmentName(raw: string): string {
	return slugifyOrEmpty(raw, ENVIRONMENT_NAME_MAX_LENGTH);
}

/** Why `raw` is unusable as an environment name, or `null` when it is fine (possibly after
 *  normalization). The single definition both creation paths and both server actions ask. */
export function environmentNameProblem(raw: string): string | null {
	if (raw.length > ENVIRONMENT_NAME_INPUT_MAX_LENGTH)
		return `Environment name is ${raw.length} characters; at most ${ENVIRONMENT_NAME_INPUT_MAX_LENGTH} are read`;
	const name = normalizeEnvironmentName(raw);
	if (!name) return "Environment name must contain at least one letter or number";
	if (RESERVED_ENVIRONMENT_NAMES.includes(name))
		return `"${name}" is reserved by the console and can't be used as an environment name`;
	return null;
}

/** An environment name: validated against `environmentNameProblem`, then normalized to its slug.
 *  Parsing yields the value that gets stored, so a caller cannot forget the normalization step —
 *  which is exactly how `project create --env Prod:production` and `project env add Prod`
 *  came to disagree. */
export const environmentNameSchema = z
	.string()
	.superRefine((raw, ctx) => {
		const problem = environmentNameProblem(raw);
		if (problem) ctx.addIssue({ code: "custom", message: problem });
	})
	.transform(normalizeEnvironmentName);

/** The prefix `argocd.AddOnAppName` puts in front of an add-on id to form the ArgoCD Application
 *  name. It is part of the LENGTH BUDGET, which is why it lives beside the cap rather than only
 *  in the Go renderer. */
export const ADDON_APP_NAME_PREFIX = "addon-";

/** The cap for an add-on / BYO-chart id. `AddOnAppName` renders `addon-<id>` as an ArgoCD
 *  Application name, and ArgoCD names are DNS-1123 labels — so the id's budget is the label limit
 *  minus the prefix. `chartSlug` previously had NO cap, which is how a long chart display name
 *  produced an Application name Kubernetes refuses. */
export const ADDON_ID_MAX_LENGTH = DNS1123_LABEL_MAX_LENGTH - ADDON_APP_NAME_PREFIX.length;

/** A BYO chart's `addon_id`, derived from its display name. Bounded so `addon-<id>` still fits a
 *  DNS-1123 label; `"chart"` when the display name slugs away entirely. */
export function chartSlug(raw: string): string {
	return slugifyOrEmpty(raw, ADDON_ID_MAX_LENGTH) || "chart";
}
