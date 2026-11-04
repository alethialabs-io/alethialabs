// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The usage pages' read inputs (#6127, ADR 0005 D1). No "use client" and no server imports: the RSC
// pages build their prefetch keys from this module and the panels build their reads from it, so the
// key the server fills and the key the browser asks for on first paint are one value.

import { DEFAULT_PRESET } from "@repo/ui/range";
import { type JobsRange, jobsRangeInput } from "@/lib/rpc/inputs/jobs";

/**
 * The window both usage pages open on: the default quick-range PRESET, not resolved bounds. A
 * resolved "last 7 days" carries the millisecond the browser computed it, so the server's prefetch
 * key and the client's key would never match and every first paint would refetch (ADR 0005 §10).
 */
export const USAGE_DEFAULT_RANGE: JobsRange = jobsRangeInput.parse({ preset: DEFAULT_PRESET });
