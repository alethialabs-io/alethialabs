CREATE TYPE "public"."hetzner_location" AS ENUM('fsn1', 'nbg1', 'hel1', 'ash', 'hil', 'sin');--> statement-breakpoint
-- fleet_pools.locations : text[] -> hetzner_location[]. Drop the default first so the enum-typed
-- DATA TYPE change lands, then re-set it. The text[]->enum[] cast is total (every stored code is a
-- valid Hetzner location; an empty array stays empty).
ALTER TABLE "fleet_pools" ALTER COLUMN "locations" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "fleet_pools" ALTER COLUMN "locations" SET DATA TYPE "public"."hetzner_location"[] USING "locations"::"public"."hetzner_location"[];--> statement-breakpoint
ALTER TABLE "fleet_pools" ALTER COLUMN "locations" SET DEFAULT '{"fsn1"}'::"public"."hetzner_location"[];--> statement-breakpoint
-- classification_dimension.applies_to : jsonb -> resource_kind[]. jsonb has no direct cast to
-- enum[], and a USING transform can't contain a subquery, so route the array-element extraction
-- through a transient IMMUTABLE helper (a plain function call is a valid transform expression).
-- array_agg over an empty '[]' is NULL, so COALESCE to '{}' preserves the NOT NULL column.
CREATE FUNCTION "public"."__jsonb_to_resource_kind_array"(j jsonb) RETURNS "public"."resource_kind"[]
	LANGUAGE sql IMMUTABLE AS $$
	SELECT COALESCE(
		(SELECT array_agg(e.val::"public"."resource_kind" ORDER BY e.ord)
		 FROM jsonb_array_elements_text(j) WITH ORDINALITY AS e(val, ord)),
		'{}'::"public"."resource_kind"[]
	);
$$;--> statement-breakpoint
ALTER TABLE "classification_dimension" ALTER COLUMN "applies_to" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "classification_dimension" ALTER COLUMN "applies_to" SET DATA TYPE "public"."resource_kind"[] USING "public"."__jsonb_to_resource_kind_array"("applies_to");--> statement-breakpoint
ALTER TABLE "classification_dimension" ALTER COLUMN "applies_to" SET DEFAULT '{}'::"public"."resource_kind"[];--> statement-breakpoint
DROP FUNCTION "public"."__jsonb_to_resource_kind_array"(jsonb);
