ALTER TABLE "service_bindings" ADD COLUMN "target_address" text;--> statement-breakpoint
ALTER TABLE "service_bindings" ADD COLUMN "output_endpoint" text;--> statement-breakpoint
ALTER TABLE "service_bindings" ADD COLUMN "output_port" text;--> statement-breakpoint
ALTER TABLE "service_bindings" ADD COLUMN "output_credential_secret" text;--> statement-breakpoint
-- Backfill the new BYO-IaC target fields from the parent JSONB `bindings` (the expand-phase source of
-- truth), matched by owner + ordinal (child ordinal is 0-based; WITH ORDINALITY is 1-based). Elements
-- with no target.address / target.output_keys leave the columns NULL (first-class component targets).
UPDATE "service_bindings" sb
SET target_address = e.elem->'target'->>'address',
    output_endpoint = e.elem->'target'->'output_keys'->>'endpoint',
    output_port = e.elem->'target'->'output_keys'->>'port',
    output_credential_secret = e.elem->'target'->'output_keys'->>'credential_secret'
FROM "project_services" ps
CROSS JOIN LATERAL jsonb_array_elements(COALESCE(ps.bindings, '[]'::jsonb)) WITH ORDINALITY AS e(elem, ord)
WHERE sb.service_id = ps.id AND sb.ordinal = (e.ord - 1)::int;--> statement-breakpoint
UPDATE "service_bindings" sb
SET target_address = e.elem->'target'->>'address',
    output_endpoint = e.elem->'target'->'output_keys'->>'endpoint',
    output_port = e.elem->'target'->'output_keys'->>'port',
    output_credential_secret = e.elem->'target'->'output_keys'->>'credential_secret'
FROM "project_chart_workloads" pcw
CROSS JOIN LATERAL jsonb_array_elements(COALESCE(pcw.bindings, '[]'::jsonb)) WITH ORDINALITY AS e(elem, ord)
WHERE sb.chart_workload_id = pcw.id AND sb.ordinal = (e.ord - 1)::int;