// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The part of the instance edition contract (`types/edition.types.ts`) the shell is given.
//
// The contract's one reader, `getInstanceEdition()` (`lib/edition/instance-edition.ts`), is
// server-only. The `[org]` layout calls it and hands the shell this slice, and every place in the
// shell that shows or hides something by edition reads the slice through `useShellEdition`
// (`./shell-edition-provider.tsx`). There is no second answer to "is this the hosted service":
// not a prop computed beside it, and not an environment variable read in the browser.
//
// It is a slice, not the whole contract, because it crosses to the browser. The licence's subject
// and dates stay on the server; nothing in the shell needs them.
//
// No "use client": the layout, a server component, calls `shellEditionOf`.

import type { InstanceEdition } from "@/types/edition.types";

/** What the shell knows about the instance: where it runs, which build it is, and what a person would call it. */
export type ShellEdition = Pick<InstanceEdition, "deployment" | "edition" | "offering">;

/** The slice of the instance edition the shell is given. */
export function shellEditionOf(edition: InstanceEdition): ShellEdition {
	return {
		deployment: edition.deployment,
		edition: edition.edition,
		offering: edition.offering,
	};
}

/**
 * Whether the instance is the hosted service. An edition that is not known (`null`: a surface
 * rendered outside the shell) is NOT hosted: what this gates is offered by Alethia Labs to its own
 * customers, and it is not offered on a guess.
 */
export function isHostedService(edition: ShellEdition | null): boolean {
	return edition?.deployment === "hosted";
}

/**
 * Whether the instance is known to be run by its own operator. An edition that is not known is
 * NOT self-managed either: what this gates is an instruction to the operator, and a customer of
 * the hosted service must never be shown one.
 */
export function isSelfManaged(edition: ShellEdition | null): boolean {
	return edition?.deployment === "self-managed";
}
