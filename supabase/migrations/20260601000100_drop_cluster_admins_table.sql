-- Drop the cluster_admins table (formerly eks_admins).
-- Cluster admins are now selected from cached IAM users, not stored separately.
DROP TABLE IF EXISTS public.cluster_admins CASCADE;
