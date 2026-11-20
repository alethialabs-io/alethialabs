"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { createContext, type ReactNode, useContext } from "react";
import type { ShellEdition } from "./shell-edition";

const ShellEditionContext = createContext<ShellEdition | null>(null);

/** Gives everything below it the instance edition the `[org]` layout read. Mounted once, by `AppShell`. */
export function ShellEditionProvider({
	edition,
	children,
}: {
	edition: ShellEdition;
	children: ReactNode;
}) {
	return <ShellEditionContext.Provider value={edition}>{children}</ShellEditionContext.Provider>;
}

/**
 * The instance edition, or `null` outside the shell. A caller decides with `isHostedService` and
 * `isSelfManaged` (`./shell-edition.ts`), both of which answer `false` for `null`: an unknown
 * edition gets neither the hosted service's offers nor an operator's instructions.
 */
export function useShellEdition(): ShellEdition | null {
	return useContext(ShellEditionContext);
}
