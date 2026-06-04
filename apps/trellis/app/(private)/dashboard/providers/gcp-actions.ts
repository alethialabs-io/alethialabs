"use server";

import { createClient } from "@/lib/supabase/server";
import type { GcpCachedResources } from "@/types/database-custom.types";
import { revalidatePath } from "next/cache";

export type GcpConnectionStatus = {
	connected: boolean;
	projectId?: string;
	serviceAccountEmail?: string;
	identityId?: string;
};

export async function getGcpConnectionStatus(): Promise<GcpConnectionStatus> {
	const supabase = await createClient();
	const {
		data: { user },
	} = await supabase.auth.getUser();
	if (!user) return { connected: false };

	const { data: identity } = await supabase
		.from("cloud_identities")
		.select("*")
		.eq("provider", "gcp")
		.eq("user_id", user.id)
		.eq("is_verified", true)
		.maybeSingle();

	if (identity) {
		return {
			connected: true,
			projectId: identity.credentials.project_id ?? undefined,
			serviceAccountEmail:
				identity.credentials.service_account_email ?? undefined,
			identityId: identity.id,
		};
	}

	return { connected: false };
}

export async function initGcpIdentity() {
	const supabase = await createClient();
	const {
		data: { user },
	} = await supabase.auth.getUser();
	if (!user) throw new Error("Unauthorized");

	const { data: existing } = await supabase
		.from("cloud_identities")
		.select("*")
		.eq("provider", "gcp")
		.eq("user_id", user.id)
		.maybeSingle();

	if (existing) {
		return { identityId: existing.id };
	}

	const { data: newIdentity, error } = await supabase
		.from("cloud_identities")
		.insert({
			provider: "gcp",
			name: "GCP Connection (Pending)",
			credentials: {},
			is_verified: false,
		})
		.select()
		.single();

	if (error) {
		throw new Error("Failed to initialize GCP connection");
	}

	return { identityId: newIdentity.id };
}

function parseWifConfig(wifConfigJson: string) {
	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(wifConfigJson);
	} catch {
		throw new Error("Invalid JSON format");
	}

	if (parsed.type !== "external_account") {
		throw new Error(
			'Invalid credential type. Expected "external_account" (Workload Identity Federation config).',
		);
	}

	const audience = parsed.audience as string | undefined;
	if (!audience || !audience.includes("workloadIdentityPools")) {
		throw new Error(
			"Missing or invalid audience field. This should reference a Workload Identity Pool.",
		);
	}

	const impersonationUrl =
		parsed.service_account_impersonation_url as string | undefined;
	if (!impersonationUrl) {
		throw new Error(
			"Missing service_account_impersonation_url. Ensure the credential config includes service account impersonation.",
		);
	}

	if (!parsed.credential_source) {
		throw new Error("Missing credential_source in the configuration.");
	}

	const projectNumberMatch = audience.match(/projects\/(\d+)\//);
	if (!projectNumberMatch) {
		throw new Error("Could not extract project number from audience.");
	}
	const projectNumber = projectNumberMatch[1];

	const saEmailMatch = impersonationUrl.match(
		/serviceAccounts\/([^:]+):generateAccessToken/,
	);
	if (!saEmailMatch) {
		throw new Error(
			"Could not extract service account email from impersonation URL.",
		);
	}
	const serviceAccountEmail = saEmailMatch[1];

	const projectIdMatch = serviceAccountEmail.match(/@([^.]+)\./);
	const projectId = projectIdMatch ? projectIdMatch[1] : undefined;

	return { parsed, projectNumber, serviceAccountEmail, projectId };
}

export async function saveGcpIdentity(
	identityId: string,
	wifConfigJson: string,
) {
	const supabase = await createClient();
	const {
		data: { user },
		error: authError,
	} = await supabase.auth.getUser();

	if (authError || !user) throw new Error("Unauthorized");

	const { parsed, projectNumber, serviceAccountEmail, projectId } =
		parseWifConfig(wifConfigJson);

	const { data: identity, error: fetchError } = await supabase
		.from("cloud_identities")
		.select("*")
		.eq("id", identityId)
		.eq("user_id", user.id)
		.single();

	if (fetchError || !identity) {
		throw new Error("Connection session not found");
	}

	const { error: updateError } = await supabase
		.from("cloud_identities")
		.update({
			name: `GCP Project (${projectId ?? projectNumber})`,
			credentials: {
				project_id: projectId,
				project_number: projectNumber,
				service_account_email: serviceAccountEmail,
				wif_config: parsed,
			},
			is_verified: false,
			updated_at: new Date().toISOString(),
		})
		.eq("id", identityId);

	if (updateError) {
		throw new Error("Failed to save connection details");
	}

	const { data: job, error: jobError } = await supabase
		.from("provision_jobs")
		.insert({
			user_id: user.id,
			job_type: "CONNECTION_TEST",
			cloud_identity_id: identityId,
			config_snapshot: {
				project_id: projectId,
				project_number: projectNumber,
				service_account_email: serviceAccountEmail,
			},
			status: "QUEUED",
		})
		.select("id")
		.single();

	if (jobError) {
		throw new Error(
			"Failed to queue connection test: " + jobError.message,
		);
	}

	return { jobId: job.id, identityId };
}

export async function verifyGcpIdentity(identityId: string, jobId?: string) {
	const supabase = await createClient();
	const {
		data: { user },
		error: authError,
	} = await supabase.auth.getUser();

	if (authError || !user) throw new Error("Unauthorized");

	const updateData: Record<string, unknown> = {
		is_verified: true,
		updated_at: new Date().toISOString(),
	};

	if (jobId) {
		const { data: job } = await supabase
			.from("provision_jobs")
			.select("execution_metadata")
			.eq("id", jobId)
			.single();

		const metadata = job?.execution_metadata;
		if (metadata?.cached_resources) {
			updateData.cached_resources =
				metadata.cached_resources as GcpCachedResources;
			updateData.cached_at = new Date().toISOString();
		}
	}

	const { error } = await supabase
		.from("cloud_identities")
		.update(updateData)
		.eq("id", identityId)
		.eq("user_id", user.id);

	if (error) {
		throw new Error("Failed to verify identity");
	}

	revalidatePath("/dashboard/integrations");
	return { success: true };
}

export async function disconnectGcpIdentity(identityId: string) {
	const supabase = await createClient();
	const {
		data: { user },
		error: authError,
	} = await supabase.auth.getUser();

	if (authError || !user) throw new Error("Unauthorized");

	const { error } = await supabase
		.from("cloud_identities")
		.update({
			name: "GCP Connection (Pending)",
			is_verified: false,
			credentials: {},
			cached_resources: null,
			cached_at: null,
			updated_at: new Date().toISOString(),
		})
		.eq("id", identityId)
		.eq("user_id", user.id);

	if (error) {
		throw new Error("Failed to disconnect GCP project");
	}

	await supabase
		.from("vines")
		.update({ cloud_identity_id: null })
		.eq("cloud_identity_id", identityId);

	return { success: true };
}

export async function refreshGcpResources(cloudIdentityId: string) {
	const supabase = await createClient();
	const {
		data: { user },
	} = await supabase.auth.getUser();

	if (!user) throw new Error("Unauthorized");

	const { data: job, error } = await supabase
		.from("provision_jobs")
		.insert({
			user_id: user.id,
			job_type: "FETCH_RESOURCES",
			cloud_identity_id: cloudIdentityId,
			config_snapshot: {},
			status: "QUEUED",
		})
		.select("id")
		.single();

	if (error)
		throw new Error("Failed to queue resource fetch: " + error.message);

	return { jobId: job.id };
}
