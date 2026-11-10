// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// What an installed add-on should be TOLD about the catalogue's chart version (#6537).
//
// A catalogue bump reaches an install in one of three ways, and only the first moves it:
//
//   managed, unpinned  resolves `row.version ?? def.version` on the next deploy, so it follows the
//                      catalogue. Nothing to say.
//   managed, pinned    keeps its pin (#5525). The pin is the user's decision, so it is never
//                      rewritten — but a pin older than the catalogue is told so, and told loudly
//                      when the catalogue's version is a security release.
//   gitops             keeps whatever `addons/<id>.yaml` in the user's apps repo says: the runner
//                      seeds that file once and never rewrites it (provisioner/addons_gitops.go).
//                      The console cannot read the repo, so it states what the catalogue ships and
//                      leaves the comparison to the runner, which reports drift on the Deploy tab.
//
// One function so the console card and `GET /api/cli/projects/:id/addons` cannot disagree. It
// imports nothing server-only, so the client card calls it directly.

import type { AddOnSecurityRelease } from "./types";

/** The catalogue half: the version the catalogue ships and whether it is a security release. */
export interface CatalogVersionFacts {
	version: string;
	securityRelease?: AddOnSecurityRelease | null;
}

/** The install half: the delivery mode and the stored pin (null = no pin). */
export interface InstallVersionFacts {
	mode: "managed" | "gitops";
	version: string | null;
}

/**
 * The update an install is offered. `pin-behind`: a managed install pinned below the catalogue.
 * `gitops`: a GitOps install, whose repo decides the version — `installedVersion` is the stored pin,
 * or null. Either way it is NOT what the repo holds; only the runner can read that.
 */
export interface AddOnUpdateNotice {
	kind: "pin-behind" | "gitops";
	catalogVersion: string;
	installedVersion: string | null;
	/** Set when the catalogue's version is a security release; the offer is then prominent. */
	security: AddOnSecurityRelease | null;
}

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * Orders two chart versions by SemVer precedence: <0 when `a` is older, >0 when newer, 0 when
 * equal. Returns null when either is not a SemVer version, so the caller says nothing rather than
 * guessing an order. A pre-release ranks below its release; pre-release identifiers compare as
 * SemVer §11 says (numeric below alphanumeric, numerically among themselves).
 */
export function compareChartVersions(a: string, b: string): number | null {
	const ma = SEMVER.exec(a);
	const mb = SEMVER.exec(b);
	if (!ma || !mb) return null;
	for (let i = 1; i <= 3; i++) {
		const d = Number(ma[i]) - Number(mb[i]);
		if (d !== 0) return d;
	}
	const pa = ma[4];
	const pb = mb[4];
	if (pa === undefined || pb === undefined) {
		if (pa === pb) return 0;
		return pa === undefined ? 1 : -1;
	}
	const ia = pa.split(".");
	const ib = pb.split(".");
	for (let i = 0; i < Math.max(ia.length, ib.length); i++) {
		const x = ia[i];
		const y = ib[i];
		if (x === undefined) return -1;
		if (y === undefined) return 1;
		const nx = /^\d+$/.test(x);
		const ny = /^\d+$/.test(y);
		if (nx && ny) {
			const d = Number(x) - Number(y);
			if (d !== 0) return d;
		} else if (nx !== ny) {
			return nx ? -1 : 1;
		} else if (x !== y) {
			return x < y ? -1 : 1;
		}
	}
	return 0;
}

/**
 * Returns the update notice for one installed add-on, or null when there is nothing to say: no
 * install, a managed install that follows the catalogue, or a pin at or above the catalogue's
 * version. It never proposes changing anything by itself — the caller offers, the user decides.
 */
export function addOnUpdateNotice(
	catalog: CatalogVersionFacts,
	install: InstallVersionFacts | null,
): AddOnUpdateNotice | null {
	if (!install) return null;
	const security = catalog.securityRelease ?? null;
	if (install.mode === "gitops") {
		// The repo decides and the console cannot read it, so the catalogue version is ALWAYS stated.
		// Not even a stored pin equal to the catalogue proves the repo current: the file was seeded
		// once, with whatever version applied then, and the user may have edited it since.
		return {
			kind: "gitops",
			catalogVersion: catalog.version,
			installedVersion: install.version,
			security,
		};
	}
	if (install.version === null) return null;
	const order = compareChartVersions(install.version, catalog.version);
	if (order === null || order >= 0) return null;
	return {
		kind: "pin-behind",
		catalogVersion: catalog.version,
		installedVersion: install.version,
		security,
	};
}
