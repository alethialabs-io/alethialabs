import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const generatedPath = path.resolve(
	__dirname,
	"../apps/trellis/types/database.types.ts",
);
const outPath = generatedPath;

let content = fs.readFileSync(generatedPath, "utf8");

/**
 * Replace a JSONB field's `Json` type with an inline type literal inside a
 * specific table's Row / Insert / Update blocks.
 *
 * @param {string} src       - Full file content
 * @param {string} table     - Table name (e.g. "cloud_identities")
 * @param {string} field     - Column name (e.g. "credentials")
 * @param {string} inlineType - Replacement type literal (e.g. "{ foo: string }")
 * @returns {string}         - Updated file content
 */
function replaceJsonField(src, table, field, inlineType) {
	const tableStart = src.indexOf(`${table}: {`);
	if (tableStart === -1) {
		console.warn(`  ⚠ table "${table}" not found — skipping`);
		return src;
	}

	let depth = 0;
	let tableEnd = tableStart;
	let foundOpen = false;
	for (let i = tableStart; i < src.length; i++) {
		if (src[i] === "{") {
			depth++;
			foundOpen = true;
		}
		if (src[i] === "}") {
			depth--;
			if (foundOpen && depth === 0) {
				tableEnd = i + 1;
				break;
			}
		}
	}

	let tableBlock = src.slice(tableStart, tableEnd);

	const rowPattern = new RegExp(`(${field}: )Json( \\| null)?`, "g");
	const insertPattern = new RegExp(`(${field}\\??: )Json( \\| null)?`, "g");

	let replaced = 0;
	tableBlock = tableBlock.replace(rowPattern, (match, prefix, nullable) => {
		replaced++;
		return `${prefix}${inlineType}${nullable ?? ""}`;
	});
	tableBlock = tableBlock.replace(
		insertPattern,
		(match, prefix, nullable) => {
			replaced++;
			return `${prefix}${inlineType}${nullable ?? ""}`;
		},
	);

	if (replaced === 0) {
		console.warn(
			`  ⚠ field "${field}" with Json type not found in "${table}" — skipping`,
		);
		return src;
	}

	console.log(`  ✓ ${table}.${field} — ${replaced} replacements`);
	return src.slice(0, tableStart) + tableBlock + src.slice(tableEnd);
}

// ── cloud_identities ────────────────────────────────────────────────
const cloudCredentialsType =
	"{ role_arn?: string | null; external_id?: string | null; account_id?: string | null; }";
content = replaceJsonField(
	content,
	"cloud_identities",
	"credentials",
	cloudCredentialsType,
);

// ── clusters ────────────────────────────────────────────────────────
const clusterMetadataType =
	"{ region?: string | null; vpc_cidr?: string | null; [key: string]: any; }";
content = replaceJsonField(
	content,
	"clusters",
	"metadata",
	clusterMetadataType,
);

// ── cloud_identities.cached_resources ───────────────────────────────
const cachedResourcesType = `{
  regions: string[];
  vpcs: Record<string, Array<{ ID: string; CIDR: string; Name: string; IsDefault: boolean }>>;
  subnets: Record<string, Record<string, Array<{ ID: string; CIDR: string; VpcID: string; AvailabilityZone: string }>>>;
  hosted_zones: Array<{ ID: string; Name: string; RecordCount: number; IsPrivate: boolean }>;
}`;
content = replaceJsonField(
	content,
	"cloud_identities",
	"cached_resources",
	cachedResourcesType,
);

// ── provision_jobs.config_snapshot ──────────────────────────────────
content = replaceJsonField(
	content,
	"provision_jobs",
	"config_snapshot",
	"Record<string, unknown>",
);

// ── provision_jobs.execution_metadata ──────────────────────────────
content = replaceJsonField(
	content,
	"provision_jobs",
	"execution_metadata",
	"Record<string, unknown>",
);

// ── vine_audit_log.changes ─────────────────────────────────────────
content = replaceJsonField(
	content,
	"vine_audit_log",
	"changes",
	"Record<string, unknown>",
);

// ── vine_eks.cluster_admins ────────────────────────────────────────
content = replaceJsonField(
	content,
	"vine_eks",
	"cluster_admins",
	"Array<{ username: string; groups: string[] }>",
);

// ── vine_topics.subscriptions ──────────────────────────────────────
content = replaceJsonField(
	content,
	"vine_topics",
	"subscriptions",
	"Array<{ protocol: string; endpoint: string }>",
);

// ── workers.metadata ───────────────────────────────────────────────
content = replaceJsonField(
	content,
	"workers",
	"metadata",
	"Record<string, unknown>",
);

fs.writeFileSync(outPath, content);
console.log(`\n✓ Wrote ${outPath}`);
