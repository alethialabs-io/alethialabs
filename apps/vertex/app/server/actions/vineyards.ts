"use server";

import { createClient } from "@/lib/supabase/server";
import type {
	PublicVineyardsInsert,
	PublicVineyardsRow,
	PublicVineyardsUpdate,
	PublicVinesRow,
} from "@/lib/validations/db.schemas";

export type VineWithProvider = PublicVinesRow & {
	cloud_provider: string | null;
};

export type VineyardWithVines = PublicVineyardsRow & {
	vines: VineWithProvider[];
};

export type GetVineyardsData = VineyardWithVines[];

/** Maps raw vine + cloud_identities join into VineWithProvider. */
function mapVinesWithProvider(raw: any[]): VineWithProvider[] {
	return (raw ?? []).map((vine: any) => {
		const provider = vine.cloud_identities?.provider ?? null;
		const { cloud_identities: _, ...rest } = vine;
		return { ...rest, cloud_provider: provider } as VineWithProvider;
	});
}

/** Fetches all vineyards with nested vines and their cloud provider. */
export async function getVineyards() {
	const supabase = await createClient();

	const { data, error } = await supabase
		.from("vineyards")
		.select("*, vines(*, cloud_identities(provider))")
		.order("created_at", { ascending: false });

	if (error) throw new Error(error.message);

	const vineyards: GetVineyardsData = (data ?? []).map((vy: any) => ({
		...vy,
		vines: mapVinesWithProvider(vy.vines),
	}));

	return { vineyards };
}

/** Fetches a single vineyard with nested vines and their cloud provider. */
export async function getVineyardById(id: string) {
	const supabase = await createClient();

	const { data, error } = await supabase
		.from("vineyards")
		.select("*, vines(*, cloud_identities(provider))")
		.eq("id", id)
		.single();

	if (error) throw new Error(error.message);

	const vineyard: VineyardWithVines = {
		...data,
		vines: mapVinesWithProvider((data as any).vines),
	};

	return { vineyard };
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
