// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Validation + pure helpers for the ephemeral PR-preview-environments (W-f, #842) server actions.
// A preview env is an ArgoCD ApplicationSet pullRequest generator installed on a Fabric: ArgoCD
// discovers each OPEN pull request on the apps repo and renders one preview Application per PR
// (create-on-open, deploy head_sha, destroy-on-close). This module resolves the SCM coordinates
// from the apps repo URL and validates the per-team placement choice — no secrets, no cloud calls.

import { z } from "zod";

/** The SCM providers whose ArgoCD pullRequest generator is supported (github + gitlab). */
export const PREVIEW_SCM_PROVIDERS = ["github", "gitlab"] as const;
export type PreviewScmProvider = (typeof PREVIEW_SCM_PROVIDERS)[number];

/** The per-team placement of each preview env on the Fabric — a namespace per PR, or a vcluster
 * per PR (forward-scaffolded; renders namespace-per-PR until per-PR vcluster provisioning ships). */
export const PREVIEW_PLACEMENTS = ["namespace", "vcluster"] as const;
export type PreviewPlacement = (typeof PREVIEW_PLACEMENTS)[number];

/** Default preview lifetime cap (hours) — stamped as an annotation for a follow-up reaper (ArgoCD
 * itself only tears a preview down on PR close). */
export const DEFAULT_PREVIEW_TTL_HOURS = 72;

/** The Kubernetes Secret (in the argocd namespace) that holds the SCM API token the pullRequest
 * generator reads. One preview ApplicationSet per Fabric, so one fixed secret name + key. */
export const PREVIEW_SCM_SECRET_NAME = "preview-scm-token";
export const PREVIEW_SCM_SECRET_KEY = "token";

/**
 * The per-team preview-env choice a user submits (the UI's enable form). Placement picks how each
 * PR's env is placed on the Fabric; ttlHours caps a preview's lifetime. Everything else (apps repo,
 * SCM coordinates, Fabric) is DERIVED server-side from the data model, never user-supplied.
 */
export const previewConfigInputSchema = z.object({
	placement: z.enum(PREVIEW_PLACEMENTS).default("namespace"),
	ttlHours: z.number().int().positive().max(720).optional(),
});
export type PreviewConfigInput = z.input<typeof previewConfigInputSchema>;

/** The SCM coordinates the ArgoCD pullRequest generator needs, derived from the apps repo URL. */
export interface PreviewScmCoords {
	provider: PreviewScmProvider;
	/** github: the repo owner. gitlab: the group path (all path segments but the last). */
	owner: string;
	/** The repository / project name (the last path segment). */
	repo: string;
}

/**
 * Derives the SCM provider + owner/repo from an apps repo git URL for the pullRequest generator.
 * Supports https and git@ (ssh) forms on github and gitlab hosts. Returns null for an unsupported
 * host or a malformed path — the caller treats that as "previews unavailable" (fail-closed).
 *
 * github is always `owner/repo`; gitlab supports nested groups, so `owner` is every path segment
 * but the last (joined with "/") and `repo` is the last — together they reconstruct the project path.
 */
export function parseAppsRepoScm(repoUrl: string): PreviewScmCoords | null {
	const url = repoUrl.trim();
	if (!url) return null;

	let host = "";
	let path = "";
	// git@host:owner/repo(.git)
	const ssh = /^git@([^:]+):(.+)$/.exec(url);
	if (ssh) {
		host = ssh[1];
		path = ssh[2];
	} else {
		// https://host/owner/repo(.git)
		const https = /^https?:\/\/([^/]+)\/(.+)$/.exec(url);
		if (!https) return null;
		host = https[1];
		path = https[2];
	}

	// Normalize: drop a trailing ".git" and any surrounding slashes.
	const segments = path
		.replace(/\.git$/, "")
		.replace(/^\/+|\/+$/g, "")
		.split("/")
		.filter(Boolean);
	if (segments.length < 2) return null;

	const provider: PreviewScmProvider | null = host.includes("github")
		? "github"
		: host.includes("gitlab")
			? "gitlab"
			: null;
	if (!provider) return null;

	const repo = segments[segments.length - 1];
	// github never nests; gitlab may, so keep the full group path as the owner.
	const owner = provider === "github" ? segments[0] : segments.slice(0, -1).join("/");
	if (!owner || !repo) return null;

	// Fail-closed charset guard: owner/repo are interpolated into the preview ApplicationSet YAML by
	// the Go renderer, so reject anything outside the SCM-safe charset (blocks YAML-special chars like
	// `:` `{` `"` `#` that a hand-crafted apps repo URL could smuggle in — the owner path may nest with
	// `/` on gitlab, the repo may not). A rejected value → previews unavailable, never a malformed manifest.
	if (!/^[A-Za-z0-9._/-]+$/.test(owner) || !/^[A-Za-z0-9._-]+$/.test(repo)) return null;
	return { provider, owner, repo };
}
