-- Storage bucket for per-vine Terraform state files.
-- Accessed via S3-compatible protocol by the Alethia worker.
INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('vine-terraform-state', 'vine-terraform-state', false, 104857600)
ON CONFLICT (id) DO NOTHING;
