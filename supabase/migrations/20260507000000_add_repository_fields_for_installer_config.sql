ALTER TABLE public.configurations
ADD COLUMN IF NOT EXISTS env_git_repo text,
ADD COLUMN IF NOT EXISTS gitops_destination_repo text,
ADD COLUMN IF NOT EXISTS applications_template_repo text,
ADD COLUMN IF NOT EXISTS applications_destination_repo text;
