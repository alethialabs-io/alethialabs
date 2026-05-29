"use server";

import { createClient } from "@/lib/supabase/server";

export type EksAdminOption = {
	id: string;
	email: string;
};

export async function getEksAdmins(): Promise<EksAdminOption[]> {
	const supabase = await createClient();
	const { data } = await supabase
		.from("eks_admins")
		.select("id, email")
		.order("created_at");
	return data ?? [];
}

export async function createEksAdmin(
	email: string,
): Promise<EksAdminOption | null> {
	const supabase = await createClient();
	const {
		data: { user },
	} = await supabase.auth.getUser();
	if (!user) return null;

	const { data, error } = await supabase
		.from("eks_admins")
		.upsert(
			{ user_id: user.id, email },
			{ onConflict: "user_id, email" },
		)
		.select("id, email")
		.single();

	if (error) return null;
	return data;
}
