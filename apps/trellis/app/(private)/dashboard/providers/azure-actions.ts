"use server";

import { createClient } from "@/lib/supabase/server";
import type { AzureCachedResources } from "@/types/database-custom.types";

export type AzureConnectionStatus = {
	connected: boolean;
	tenantId?: string;
	subscriptionId?: string;
	clientId?: string;
	identityId?: string;
};

export async function getAzureConnectionStatus(): Promise<AzureConnectionStatus> {
	const supabase = await createClient();
	const {
		data: { user },
	} = await supabase.auth.getUser();
	if (!user) return { connected: false };

	const { data: identity } = await supabase
		.from("cloud_identities")
		.select("*")
		.eq("provider", "azure")
		.eq("user_id", user.id)
		.eq("is_verified", true)
		.maybeSingle();

	if (identity) {
		return {
			connected: true,
			tenantId: identity.credentials.tenant_id ?? undefined,
			subscriptionId:
				identity.credentials.subscription_id ?? undefined,
			clientId: identity.credentials.client_id ?? undefined,
			identityId: identity.id,
		};
	}

	return { connected: false };
}

export async function initAzureIdentity() {
	const supabase = await createClient();
	const {
		data: { user },
	} = await supabase.auth.getUser();
	if (!user) throw new Error("Unauthorized");

	const { data: existing } = await supabase
		.from("cloud_identities")
		.select("*")
		.eq("provider", "azure")
		.eq("user_id", user.id)
		.maybeSingle();

	if (existing) {
		return { identityId: existing.id };
	}

	const { data: newIdentity, error } = await supabase
		.from("cloud_identities")
		.insert({
			provider: "azure",
			name: "Azure Connection (Pending)",
			credentials: {},
			is_verified: false,
		})
		.select()
		.single();

	if (error) {
		throw new Error("Failed to initialize Azure connection");
	}

	return { identityId: newIdentity.id };
}

const GUID_REGEX =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function saveAzureIdentity(
	identityId: string,
	tenantId: string,
	clientId: string,
	subscriptionId: string,
) {
	const supabase = await createClient();
	const {
		data: { user },
		error: authError,
	} = await supabase.auth.getUser();

	if (authError || !user) throw new Error("Unauthorized");

	if (!GUID_REGEX.test(tenantId)) {
		throw new Error("Invalid Tenant ID format. Expected a UUID.");
	}
	if (!GUID_REGEX.test(clientId)) {
		throw new Error(
			"Invalid Client ID (Application ID) format. Expected a UUID.",
		);
	}
	if (!GUID_REGEX.test(subscriptionId)) {
		throw new Error("Invalid Subscription ID format. Expected a UUID.");
	}

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
			name: `Azure Subscription (${subscriptionId.slice(0, 8)}...)`,
			credentials: {
				tenant_id: tenantId,
				client_id: clientId,
				subscription_id: subscriptionId,
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
				tenant_id: tenantId,
				client_id: clientId,
				subscription_id: subscriptionId,
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

export async function verifyAzureIdentity(
	identityId: string,
	jobId?: string,
) {
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
				metadata.cached_resources as AzureCachedResources;
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

	return { success: true };
}

export async function disconnectAzureIdentity(identityId: string) {
	const supabase = await createClient();
	const {
		data: { user },
		error: authError,
	} = await supabase.auth.getUser();

	if (authError || !user) throw new Error("Unauthorized");

	const { error } = await supabase
		.from("cloud_identities")
		.update({
			name: "Azure Connection (Pending)",
			is_verified: false,
			credentials: {},
			cached_resources: null,
			cached_at: null,
			updated_at: new Date().toISOString(),
		})
		.eq("id", identityId)
		.eq("user_id", user.id);

	if (error) {
		throw new Error("Failed to disconnect Azure subscription");
	}

	await supabase
		.from("vines")
		.update({ cloud_identity_id: null })
		.eq("cloud_identity_id", identityId);

	return { success: true };
}

export async function refreshAzureResources(cloudIdentityId: string) {
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
