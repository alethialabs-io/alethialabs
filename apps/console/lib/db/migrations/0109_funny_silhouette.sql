CREATE TABLE "service_binding_injections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"binding_id" uuid NOT NULL,
	"env" text NOT NULL,
	"from_facet" "service_binding_facet" NOT NULL,
	"ordinal" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "service_bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"service_id" uuid,
	"chart_workload_id" uuid,
	"target_kind" "service_binding_kind" NOT NULL,
	"target_name" text NOT NULL,
	"ordinal" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "service_bindings_one_owner_ck" CHECK (("service_bindings"."service_id" IS NOT NULL) <> ("service_bindings"."chart_workload_id" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "service_binding_injections" ADD CONSTRAINT "service_binding_injections_binding_id_service_bindings_id_fk" FOREIGN KEY ("binding_id") REFERENCES "public"."service_bindings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_bindings" ADD CONSTRAINT "service_bindings_service_id_project_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."project_services"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_bindings" ADD CONSTRAINT "service_bindings_chart_workload_id_project_chart_workloads_id_fk" FOREIGN KEY ("chart_workload_id") REFERENCES "public"."project_chart_workloads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "service_binding_injections_binding_id_idx" ON "service_binding_injections" USING btree ("binding_id");--> statement-breakpoint
CREATE INDEX "service_bindings_service_id_idx" ON "service_bindings" USING btree ("service_id");--> statement-breakpoint
CREATE INDEX "service_bindings_chart_workload_id_idx" ON "service_bindings" USING btree ("chart_workload_id");--> statement-breakpoint
-- Backfill: migrate the JSONB `bindings` from BOTH owners into normalized rows, preserving author
-- order via `ordinal` (the ORIGINAL array index, so injections rejoin by owner+ordinal). Filter to
-- valid enum kinds + non-empty target names so the enum cast can't fail. Bindings first, then their
-- nested injections rejoined to the just-inserted binding rows.
INSERT INTO "service_bindings" ("service_id", "chart_workload_id", "target_kind", "target_name", "ordinal")
SELECT s."id", NULL,
       (e.elem->'target'->>'kind')::"service_binding_kind",
       e.elem->'target'->>'name',
       (e.ord - 1)::int
FROM "project_services" s
CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s."bindings", '[]'::jsonb)) WITH ORDINALITY AS e(elem, ord)
WHERE COALESCE(e.elem->'target'->>'name', '') <> ''
  AND (e.elem->'target'->>'kind') IN ('database','cache','queue','secret');--> statement-breakpoint
INSERT INTO "service_bindings" ("service_id", "chart_workload_id", "target_kind", "target_name", "ordinal")
SELECT NULL, w."id",
       (e.elem->'target'->>'kind')::"service_binding_kind",
       e.elem->'target'->>'name',
       (e.ord - 1)::int
FROM "project_chart_workloads" w
CROSS JOIN LATERAL jsonb_array_elements(COALESCE(w."bindings", '[]'::jsonb)) WITH ORDINALITY AS e(elem, ord)
WHERE COALESCE(e.elem->'target'->>'name', '') <> ''
  AND (e.elem->'target'->>'kind') IN ('database','cache','queue','secret');--> statement-breakpoint
-- Injections for service-owned bindings: rejoin each binding row to its source binding (owner+ordinal)
-- and unnest the inject array.
INSERT INTO "service_binding_injections" ("binding_id", "env", "from_facet", "ordinal")
SELECT sb."id",
       inj.elem->>'env',
       (inj.elem->>'from')::"service_binding_facet",
       (inj.ord - 1)::int
FROM "service_bindings" sb
JOIN "project_services" s ON s."id" = sb."service_id"
CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s."bindings", '[]'::jsonb)) WITH ORDINALITY AS b(elem, ord)
CROSS JOIN LATERAL jsonb_array_elements(COALESCE(b.elem->'inject', '[]'::jsonb)) WITH ORDINALITY AS inj(elem, ord)
WHERE sb."service_id" IS NOT NULL AND (b.ord - 1) = sb."ordinal"
  AND COALESCE(inj.elem->>'env', '') <> ''
  AND (inj.elem->>'from') IN ('endpoint','port','username','password','connection_string');--> statement-breakpoint
-- Injections for chart-workload-owned bindings.
INSERT INTO "service_binding_injections" ("binding_id", "env", "from_facet", "ordinal")
SELECT sb."id",
       inj.elem->>'env',
       (inj.elem->>'from')::"service_binding_facet",
       (inj.ord - 1)::int
FROM "service_bindings" sb
JOIN "project_chart_workloads" w ON w."id" = sb."chart_workload_id"
CROSS JOIN LATERAL jsonb_array_elements(COALESCE(w."bindings", '[]'::jsonb)) WITH ORDINALITY AS b(elem, ord)
CROSS JOIN LATERAL jsonb_array_elements(COALESCE(b.elem->'inject', '[]'::jsonb)) WITH ORDINALITY AS inj(elem, ord)
WHERE sb."chart_workload_id" IS NOT NULL AND (b.ord - 1) = sb."ordinal"
  AND COALESCE(inj.elem->>'env', '') <> ''
  AND (inj.elem->>'from') IN ('endpoint','port','username','password','connection_string');