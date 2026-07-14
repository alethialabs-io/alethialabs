"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The environment's server truth, fetched ONCE per canvas and read by every node.
//
// Without this each card would run its own query — forty nodes, forty round-trips, forty poll
// timers. The workbench fetches the whole environment's status in one call and publishes it here;
// `useNodeStatus` picks its own row out by `nodeStatusKey()`.

import { createContext, useContext } from "react";
import {
	EMPTY_ENVIRONMENT_STATUS,
	type EnvironmentStatus,
} from "./component-status";

const EnvironmentStatusContext = createContext<EnvironmentStatus>(
	EMPTY_ENVIRONMENT_STATUS,
);

export const EnvironmentStatusProvider = EnvironmentStatusContext.Provider;

/**
 * The current environment's server status. Defaults to the EMPTY status outside a provider (the
 * create flow, where nothing is provisioned yet) and while the first fetch is in flight — so a node
 * always falls back to its design readiness rather than blocking on the network or flashing a wrong
 * state.
 */
export function useEnvironmentStatus(): EnvironmentStatus {
	return useContext(EnvironmentStatusContext);
}
