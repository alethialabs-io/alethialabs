-- Storage bucket for terraform plan binary files.
-- Accessed only via service role through the Trellis API.
INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('plan-artifacts', 'plan-artifacts', false, 52428800)
ON CONFLICT (id) DO NOTHING;
