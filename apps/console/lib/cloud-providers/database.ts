// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { CloudProviderSlug } from "./registry";

interface DbEngineOption {
	value: string;
	label: string;
	defaultVersion: string;
}

/** Database engine options per provider. */
export const DB_ENGINES: Record<CloudProviderSlug, DbEngineOption[]> = {
	aws: [
		{ value: "aurora-postgresql", label: "Aurora PostgreSQL", defaultVersion: "16.6" },
		{ value: "aurora-mysql", label: "Aurora MySQL", defaultVersion: "8.0" },
	],
	gcp: [
		{ value: "cloudsql-postgresql", label: "Cloud SQL PostgreSQL", defaultVersion: "15" },
		{ value: "cloudsql-mysql", label: "Cloud SQL MySQL", defaultVersion: "8.0" },
	],
	azure: [
		{ value: "azure-postgresql", label: "Azure Database for PostgreSQL", defaultVersion: "16" },
		{ value: "azure-mysql", label: "Azure Database for MySQL", defaultVersion: "8.0" },
	],
	hetzner: [
		{ value: "postgres", label: "PostgreSQL (CloudNativePG)", defaultVersion: "16" },
	],
	alibaba: [
		{ value: "postgres", label: "ApsaraDB RDS PostgreSQL", defaultVersion: "16.0" },
		{ value: "mysql", label: "ApsaraDB RDS MySQL", defaultVersion: "8.0" },
	],
};

interface CapacityModel {
	unit: string;
	min: number;
	max: number;
	step: number;
	defaultMin: number;
	defaultMax: number;
}

/** Capacity model (scaling units) per provider. */
export const DB_CAPACITY: Record<CloudProviderSlug, CapacityModel> = {
	aws: { unit: "ACU", min: 0.5, max: 128, step: 0.5, defaultMin: 0.5, defaultMax: 4 },
	gcp: { unit: "vCPU", min: 1, max: 96, step: 1, defaultMin: 1, defaultMax: 4 },
	azure: { unit: "vCores", min: 1, max: 64, step: 1, defaultMin: 2, defaultMax: 4 },
	hetzner: { unit: "GiB", min: 5, max: 500, step: 5, defaultMin: 10, defaultMax: 10 },
	alibaba: { unit: "vCPU", min: 1, max: 64, step: 1, defaultMin: 2, defaultMax: 4 },
};

/** Cross-provider database engine mapping for project conversion. */
export const ENGINE_MAP: Record<
	CloudProviderSlug,
	Record<CloudProviderSlug, Record<string, string>>
> = {
	aws: {
		aws: {},
		gcp: {
			"aurora-postgresql": "cloudsql-postgresql",
			"aurora-mysql": "cloudsql-mysql",
		},
		azure: {
			"aurora-postgresql": "azure-postgresql",
			"aurora-mysql": "azure-mysql",
		},
		hetzner: {
			"aurora-postgresql": "postgres",
		},
		alibaba: {
			"aurora-postgresql": "postgres",
			"aurora-mysql": "mysql",
		},
	},
	gcp: {
		gcp: {},
		aws: {
			"cloudsql-postgresql": "aurora-postgresql",
			"cloudsql-mysql": "aurora-mysql",
		},
		azure: {
			"cloudsql-postgresql": "azure-postgresql",
			"cloudsql-mysql": "azure-mysql",
		},
		hetzner: {
			"cloudsql-postgresql": "postgres",
		},
		alibaba: {
			"cloudsql-postgresql": "postgres",
			"cloudsql-mysql": "mysql",
		},
	},
	azure: {
		azure: {},
		aws: {
			"azure-postgresql": "aurora-postgresql",
			"azure-mysql": "aurora-mysql",
		},
		gcp: {
			"azure-postgresql": "cloudsql-postgresql",
			"azure-mysql": "cloudsql-mysql",
		},
		hetzner: {
			"azure-postgresql": "postgres",
		},
		alibaba: {
			"azure-postgresql": "postgres",
			"azure-mysql": "mysql",
		},
	},
	hetzner: {
		hetzner: {},
		aws: { postgres: "aurora-postgresql" },
		gcp: { postgres: "cloudsql-postgresql" },
		azure: { postgres: "azure-postgresql" },
		alibaba: { postgres: "postgres" },
	},
	alibaba: {
		alibaba: {},
		aws: {
			postgres: "aurora-postgresql",
			mysql: "aurora-mysql",
		},
		gcp: {
			postgres: "cloudsql-postgresql",
			mysql: "cloudsql-mysql",
		},
		azure: {
			postgres: "azure-postgresql",
			mysql: "azure-mysql",
		},
		hetzner: { postgres: "postgres" },
	},
};
