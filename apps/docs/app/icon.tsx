// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Was a hand-rolled icon.svg at the same size producing the same artifact, but with
// drifted geometry (stroke 2.6 / dot r 3.1 against the canonical 2.4 / 2.9), so the
// docs favicon was visibly fatter than the console's and the marketing site's.
// Re-exported like apps/console and apps/marketing so there is one generator.
export { default, size, contentType } from "@repo/brand/icon";
