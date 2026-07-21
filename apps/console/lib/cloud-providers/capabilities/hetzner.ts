// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Hetzner capability enumeration (epic #928, lane #937). STUB — scaffolded by seams #932; lane #937
// implements it: /locations (regions) + /datacenters (server_types.available ⇒ launchable; .supported
// minus .available ⇒ capacity_blocked) + /server_types for specs; generalizes the shipped fleet
// serverTypeAvailabilityFromTypes (mirror origin/dev #919). Quota = not_evaluable (no queryable project
// quota — 403-reactive only). Token cloud: decrypts the stored project token (not keyless federation).

import type { SyncCapabilities } from "./types";

/** Enumerate this Hetzner project's launchable locations + server types. TODO(#937). No-op until then. */
export const syncHetznerCapabilities: SyncCapabilities = async (_identity) => {
	// Intentionally empty — see lane #937.
};
