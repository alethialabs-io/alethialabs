// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { CloudProviderSlug } from "./registry";

interface NosqlConfig {
	serviceName: string;
	supportsRangeKey: boolean;
	supportsGlobalTables: boolean;
	billingModes: { value: string; label: string }[];
	keyTypes: { value: string; label: string }[];
	portabilityNote: string | null;
}

/** NoSQL service configuration per provider. */
export const NOSQL: Record<CloudProviderSlug, NosqlConfig> = {
	aws: {
		serviceName: "DynamoDB",
		supportsRangeKey: true,
		supportsGlobalTables: true,
		billingModes: [
			{ value: "PAY_PER_REQUEST", label: "On-Demand" },
			{ value: "PROVISIONED", label: "Provisioned" },
		],
		keyTypes: [
			{ value: "S", label: "String" },
			{ value: "N", label: "Number" },
			{ value: "B", label: "Binary" },
		],
		portabilityNote: null,
	},
	gcp: {
		serviceName: "Firestore",
		supportsRangeKey: false,
		supportsGlobalTables: false,
		billingModes: [
			{ value: "PAY_PER_REQUEST", label: "Native Mode" },
		],
		keyTypes: [
			{ value: "S", label: "String" },
			{ value: "N", label: "Number" },
		],
		portabilityNote:
			"Firestore uses a document-collection model. DynamoDB key schemas will be adapted to Firestore document IDs.",
	},
	azure: {
		serviceName: "Cosmos DB",
		supportsRangeKey: true,
		supportsGlobalTables: true,
		billingModes: [
			{ value: "PAY_PER_REQUEST", label: "Serverless" },
			{ value: "PROVISIONED", label: "Provisioned Throughput" },
		],
		keyTypes: [
			{ value: "S", label: "String" },
			{ value: "N", label: "Number" },
		],
		portabilityNote:
			"Cosmos DB partition keys cannot be changed after creation. Review the key strategy before provisioning.",
	},
};
