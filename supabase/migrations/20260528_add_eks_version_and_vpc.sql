ALTER TABLE public.configurations ADD COLUMN IF NOT EXISTS eks_version TEXT DEFAULT '1.32';
ALTER TABLE public.configurations ADD COLUMN IF NOT EXISTS selected_vpc_id TEXT;
