"use server";

import { createClient } from "@/lib/supabase/server";

export type ClusterAdminOption = {
	id: string;
	email: string;
};

/** @deprecated Use ClusterAdminOption */
export type EksAdminOption = ClusterAdminOption;

/** Fetches saved cluster admin emails for the current user. */
export async function getClusterAdmins(): Promise<ClusterAdminOption[]> {
	const supabase = await createClient();
	const { data } = await supabase
		.from("cluster_admins")
		.select("id, email")
		.order("created_at");
	return data ?? [];
}

/** @deprecated Use getClusterAdmins */
export const getEksAdmins = getClusterAdmins;

/** Creates or upserts a cluster admin email for the current user. */
export async function createClusterAdmin(
	email: string,
): Promise<ClusterAdminOption | null> {
	const supabase = await createClient();
	const {
		data: { user },
	} = await supabase.auth.getUser();
	if (!user) return null;

	const { data, error } = await supabase
		.from("cluster_admins")
		.upsert(
			{ user_id: user.id, email },
			{ onConflict: "user_id, email" },
		)
		.select("id, email")
		.single();

	if (error) return null;
	return data;
}

/** @deprecated Use createClusterAdmin */
export const createEksAdmin = createClusterAdmin;
