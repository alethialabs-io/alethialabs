"use server";

import { createClient } from "@/lib/supabase/server";
import type {
	PublicVineyardsInsert,
	PublicVineyardsRow,
	PublicVineyardsUpdate,
	PublicVinesRow,
} from "@/lib/validations/db.schemas";

export type VineyardWithVines = PublicVineyardsRow & {
	vines: PublicVinesRow[];
};

export type GetVineyardsData = VineyardWithVines[];

export async function getVineyards() {
	const supabase = await createClient();

	const { data, error } = await supabase
		.from("vineyards")
		.select("*, vines(*)")
		.order("created_at", { ascending: false });

	if (error) throw new Error(error.message);

	return { vineyards: (data ?? []) as GetVineyardsData };
}

export async function getVineyardById(id: string) {
	const supabase = await createClient();

	const { data, error } = await supabase
		.from("vineyards")
		.select("*")
		.eq("id", id)
		.single();

	if (error) throw new Error(error.message);

	return { vineyard: data };
}

export async function createVineyard(
	body: Omit<PublicVineyardsInsert, "user_id">,
) {
	const supabase = await createClient();

	const {
		data: { user },
	} = await supabase.auth.getUser();
	if (!user) throw new Error("Unauthorized");

	const { data, error } = await supabase
		.from("vineyards")
		.insert({ ...body, user_id: user.id })
		.select()
		.single();

	if (error) throw new Error(error.message);

	return { vineyard: data };
}

export async function updateVineyard(id: string, body: PublicVineyardsUpdate) {
	const supabase = await createClient();

	const { data, error } = await supabase
		.from("vineyards")
		.update(body)
		.eq("id", id)
		.select()
		.single();

	if (error) throw new Error(error.message);

	return { vineyard: data };
}

export async function deleteVineyard(id: string) {
	const supabase = await createClient();

	const { error } = await supabase.from("vineyards").delete().eq("id", id);
	if (error) throw new Error(error.message);

	return { success: true };
}
