// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { ReactNode } from "react";
import { SupportShell } from "@/components/support/support-shell";

/** Wraps every Support surface in the thin, centered content column. */
export default function SupportLayout({ children }: { children: ReactNode }) {
	return <SupportShell>{children}</SupportShell>;
}
