// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { CanvasNodeData } from "./types";

/**
 * The human name a node carries in its config: array kinds (database/cache/queue/
 * topic/nosql/secret/bucket/registry) use `name`, the project root uses `project_name`; the rest
 * (network/cluster/dns/repositories) have no name. Narrows on the discriminant so
 * each branch reads a fully-typed config — no casts.
 */
export function configName(data: CanvasNodeData): string | undefined {
	switch (data.kind) {
		case "project":
			return data.config.project_name;
		case "database":
		case "cache":
		case "queue":
		case "topic":
		case "nosql":
		case "secret":
		case "bucket":
		case "registry":
			return data.config.name;
		case "chart":
			return data.config.id;
		default:
			return undefined;
	}
}
