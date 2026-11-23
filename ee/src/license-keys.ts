// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: LicenseRef-Alethia-Commercial

// The licence verification keys this build trusts, and whether this is a release image build.
//
// Custody (spec editions-ee-selfhost §4.1, EDN-E3): the verification key belongs to Alethia Labs
// and ships INSIDE the enterprise build. It is not an operator setting. The signing (private)
// halves never enter this repository, CI or a customer's hands; they are held offline by Alethia
// Labs and reach the issuance tool (ee/scripts/issue-license.ts) only through the credential
// broker's environment.
//
// The list holds the PUBLIC halves only, as SPKI PEM. Public keys are not secret; committing them
// is the point. Two keys may be listed at once so a key can be rotated: licences signed by either
// verify. Retiring a key is removing its entry, after every licence it signed has been reissued.
//
// While the list is empty, an installed licence cannot be verified by a release image and is
// reported `invalid`. That is the fail-safe state: nothing unlocks until a real key ships here.

/** One built-in licence verification key. */
export interface BuiltInLicenseKey {
	/** A short, stable name for the key, e.g. `2026-12-a`. Shown in diagnostics only. */
	id: string;
	/** The ed25519 public key as an SPKI PEM (`-----BEGIN PUBLIC KEY-----`). */
	spkiPem: string;
}

/**
 * The licence verification keys compiled into this build. Add the public half of each Alethia
 * Labs licence signing keypair here (at most two at a time, for rotation).
 */
export const BUILT_IN_LICENSE_KEYS: readonly BuiltInLicenseKey[] = [];

// Replaced at build time by `esbuild --define:__ALETHIA_LICENSE_IMAGE_BUILD__=true`, which the
// enterprise image's Dockerfile passes to the ee build. Anywhere else (vitest, a local or CI ee
// build) the identifier is not defined and `typeof` reads "undefined".
declare const __ALETHIA_LICENSE_IMAGE_BUILD__: boolean | undefined;

/**
 * Whether this code was compiled into a release image. A release image verifies licences only
 * against {@link BUILT_IN_LICENSE_KEYS} and ignores every runtime override, whatever `NODE_ENV`
 * says, because `NODE_ENV` is an operator-controlled environment variable and the build flag is
 * not.
 */
export function isImageBuild(): boolean {
	return (
		typeof __ALETHIA_LICENSE_IMAGE_BUILD__ !== "undefined" &&
		__ALETHIA_LICENSE_IMAGE_BUILD__ === true
	);
}
