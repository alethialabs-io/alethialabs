// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// W4 — inline, per-field validation for the inspector config forms. Each node kind is validated
// against the SAME Drizzle-derived zod item schema the whole-graph save uses (project-form.schema),
// so what the form accepts always conforms to what the DB will store. Draft→Save is unchanged; this
// only surfaces the errors per field as you edit instead of only as a blocked save later.

import type { ZodTypeAny } from "zod";
import {
	bucketItemSchema,
	cacheItemSchema,
	clusterSchema,
	databaseItemSchema,
	dnsSchema,
	networkSchema,
	nosqlItemSchema,
	projectSchema,
	queueItemSchema,
	registryItemSchema,
	repositoriesSchema,
	secretItemSchema,
	serviceItemSchema,
	topicItemSchema,
} from "@/lib/validations/project-form.schema";
import type { NodeKind } from "../graph/types";

/** The per-node zod schema for a kind, or undefined for kinds with no first-class form (out-of-band
 * add-ons / charts / external / chart_workload are configured elsewhere). */
const SCHEMA_BY_KIND: Partial<Record<NodeKind, ZodTypeAny>> = {
	service: serviceItemSchema,
	database: databaseItemSchema,
	cache: cacheItemSchema,
	queue: queueItemSchema,
	topic: topicItemSchema,
	nosql: nosqlItemSchema,
	secret: secretItemSchema,
	bucket: bucketItemSchema,
	registry: registryItemSchema,
	project: projectSchema,
	network: networkSchema,
	cluster: clusterSchema,
	dns: dnsSchema,
	repositories: repositoriesSchema,
};

/**
 * Validate one node's config against its kind's item schema and return a map of top-level field key
 * → the first error message for that field. Empty when the config is valid, the kind has no schema,
 * or the issue can't be attributed to a field. Never throws.
 */
export function validateNodeConfig(
	kind: NodeKind,
	config: Record<string, unknown>,
): Record<string, string> {
	const schema = SCHEMA_BY_KIND[kind];
	if (!schema) return {};
	const res = schema.safeParse(config);
	if (res.success) return {};
	const errors: Record<string, string> = {};
	for (const issue of res.error.issues) {
		const key = issue.path.length > 0 ? String(issue.path[0]) : "";
		// First error per field wins (the field renders one message).
		if (key && !(key in errors)) errors[key] = issue.message;
	}
	return errors;
}
