// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { wakeFleetScaler } from "@/lib/fleet/scaler";

/**
 * Prompt an immediate scale-up check on enqueue by waking the in-app fleet scaler
 * (a no-op unless FLEET_POOLS is configured). Safe to call fire-and-forget. The
 * legacy AWS Lambda scaler it used to ping was retired with infra/fleet-aws.
 */
export function notifyScaler() {
	wakeFleetScaler();
}
