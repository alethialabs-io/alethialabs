// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// What the browser does with an opened seal (#5285): read the plaintext as the ONE credential shape the
// card asks for — a static, read-only kubeconfig — and name the file it is saved as.
//
// WHY A LOCAL SCHEMA. The wire contract for the plaintext is `kubeconfigMintCredential` in
// lib/validations/cli-contract.ts, but that module imports the Drizzle schema and drizzle-zod, which
// must not ride into a client bundle. So this is the `static` arm of it, narrowed to the tier the card
// requests. tests/components/clusters/kubeconfig-download/credential.test.ts parses the same inputs
// through both and fails if they disagree on a static credential, so the two cannot drift silently.

import { z } from "zod";
import { slugify } from "@/lib/utils/slugify";

/** The plaintext the card accepts: the contract's `static` arm, tier pinned to `readonly`. A runner
 *  that sealed an `exec` or an `admin` credential to a read-only request is refused, not saved. */
export const staticReadonlyCredential = z
	.object({
		shape: z.literal("static"),
		tier: z.literal("readonly"),
		kubeconfig: z.string().min(1),
		expires_at: z.iso.datetime({ offset: true }),
	})
	.strict();

/** The parts of an opened credential the card keeps after the file is handed over. */
export interface OpenedKubeconfig {
	kubeconfig: string;
	expiresAt: string;
}

/**
 * Decodes and validates the opened plaintext bytes, then ZEROES them — the bytes are the only copy the
 * caller could otherwise forget to clear. Returns null for anything that is not a static read-only
 * credential. Never echoes the input in an error.
 */
export function readOpenedCredential(plaintext: Uint8Array): OpenedKubeconfig | null {
	let json: unknown;
	try {
		json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext));
	} catch {
		return null;
	} finally {
		plaintext.fill(0);
	}
	const parsed = staticReadonlyCredential.safeParse(json);
	if (!parsed.success) return null;
	return { kubeconfig: parsed.data.kubeconfig, expiresAt: parsed.data.expires_at };
}

/** `alethia-<project>-<env>.kubeconfig` — the file name, and the same `alethia-<project>-<env>` the CLI
 *  names its context (#5250 §4), each part through THE console slugifier. */
export function kubeconfigFileName(projectName: string, environment: string): string {
	return `alethia-${slugify(projectName, "cluster")}-${slugify(environment, "cluster")}.kubeconfig`;
}
