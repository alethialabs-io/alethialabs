"use server";

import { createClient } from "@/lib/supabase/server";
import { randomUUID } from "crypto";

export type AwsConnectionStatus = {
	connected: boolean;
	accountId?: string;
	roleArn?: string;
	identityId?: string;
	externalId?: string;
};

export async function getAwsConnectionStatus(): Promise<AwsConnectionStatus> {
	const supabase = await createClient();

	const { data: identity } = await supabase
		.from("cloud_identities")
		.select("*")
		.eq("provider", "aws")
		.eq("is_verified", true)
		.maybeSingle();

	if (identity) {
		const credentials = identity.credentials as Record<string, any>;
		return {
			connected: true,
			accountId: credentials.account_id,
			roleArn: credentials.role_arn,
			identityId: identity.id,
		};
	}

	return { connected: false };
}

export async function getAwsExternalId() {
	const supabase = await createClient();

	// UNIQUE constraint on (user_id, provider) guarantees at most one row
	const { data: existing } = await supabase
		.from("cloud_identities")
		.select("*")
		.eq("provider", "aws")
		.maybeSingle();

	if (existing) {
		const credentials = existing.credentials as Record<string, any>;
		if (credentials?.external_id) {
			return {
				externalId: credentials.external_id as string,
				identityId: existing.id,
			};
		}
	}

	const newExternalId = randomUUID();
	const { data: newIdentity, error } = await supabase
		.from("cloud_identities")
		.insert({
			provider: "aws",
			name: "AWS Connection (Pending)",
			credentials: { external_id: newExternalId },
			is_verified: false,
		})
		.select()
		.single();

	if (error) {
		throw new Error("Failed to initialize AWS connection");
	}

	return {
		externalId: newExternalId,
		identityId: newIdentity.id,
	};
}

export async function refreshAwsResources(cloudIdentityId: string) {
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

	if (error) throw new Error("Failed to queue resource fetch: " + error.message);

	return { jobId: job.id };
}

export async function persistCachedResources(cloudIdentityId: string, jobId: string) {
	const supabase = await createClient();

	const { data: job } = await supabase
		.from("provision_jobs")
		.select("execution_metadata")
		.eq("id", jobId)
		.single();

	const metadata = job?.execution_metadata as Record<string, any> | null;
	if (!metadata?.cached_resources) return { success: false };

	await supabase
		.from("cloud_identities")
		.update({
			cached_resources: metadata.cached_resources,
			cached_at: new Date().toISOString(),
		})
		.eq("id", cloudIdentityId);

	return { success: true };
}

export async function saveAwsIdentity(identityId: string, roleArn: string) {
	const supabase = await createClient();
	const {
		data: { user },
		error: authError,
	} = await supabase.auth.getUser();

	if (authError || !user) throw new Error("Unauthorized");

	const arnRegex = /^arn:aws:iam::(\d{12}):role\/[\w+=,.@-]+$/;
	const match = roleArn.match(arnRegex);

	if (!match) {
		throw new Error(
			"Invalid format. Expected: arn:aws:iam::123456789012:role/RoleName",
		);
	}

	const awsAccountId = match[1];

	const { data: identity, error: fetchError } = await supabase
		.from("cloud_identities")
		.select("*")
		.eq("id", identityId)
		.eq("user_id", user.id)
		.single();

	if (fetchError || !identity) {
		throw new Error("Connection session not found");
	}

	const currentCredentials = identity.credentials as Record<string, any>;

	const { error: updateError } = await supabase
		.from("cloud_identities")
		.update({
			name: `AWS Account (${awsAccountId})`,
			credentials: {
				...currentCredentials,
				role_arn: roleArn,
				account_id: awsAccountId,
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
			config_snapshot: { role_arn: roleArn, account_id: awsAccountId },
			status: "QUEUED",
		})
		.select("id")
		.single();

	if (jobError) {
		throw new Error("Failed to queue connection test: " + jobError.message);
	}

	return { jobId: job.id, identityId };
}

export async function verifyAwsIdentity(identityId: string, jobId?: string) {
	const supabase = await createClient();
	const {
		data: { user },
		error: authError,
	} = await supabase.auth.getUser();

	if (authError || !user) throw new Error("Unauthorized");

	const updateData: Record<string, any> = {
		is_verified: true,
		updated_at: new Date().toISOString(),
	};

	if (jobId) {
		const { data: job } = await supabase
			.from("provision_jobs")
			.select("execution_metadata")
			.eq("id", jobId)
			.single();

		const metadata = job?.execution_metadata as Record<string, any> | null;
		if (metadata?.cached_resources) {
			updateData.cached_resources = metadata.cached_resources;
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

export async function disconnectAwsIdentity(identityId: string) {
	const supabase = await createClient();
	const {
		data: { user },
		error: authError,
	} = await supabase.auth.getUser();

	if (authError || !user) throw new Error("Unauthorized");

	const { data: identity } = await supabase
		.from("cloud_identities")
		.select("credentials")
		.eq("id", identityId)
		.eq("user_id", user.id)
		.single();

	if (!identity) throw new Error("Identity not found");

	const currentCredentials = identity.credentials as Record<string, any>;

	const { error } = await supabase
		.from("cloud_identities")
		.update({
			name: "AWS Connection (Pending)",
			is_verified: false,
			credentials: { external_id: currentCredentials?.external_id },
			cached_resources: null,
			cached_at: null,
			updated_at: new Date().toISOString(),
		})
		.eq("id", identityId)
		.eq("user_id", user.id);

	if (error) {
		throw new Error("Failed to disconnect AWS account");
	}

	await supabase
		.from("configurations")
		.update({ cloud_identity_id: null })
		.eq("cloud_identity_id", identityId);

	await supabase
		.from("vines")
		.update({ cloud_identity_id: null })
		.eq("cloud_identity_id", identityId);

	return { success: true };
}
