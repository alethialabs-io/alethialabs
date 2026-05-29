-- Cache AWS resources (regions, VPCs, subnets, hosted zones) on cloud_identities
ALTER TABLE public.cloud_identities
  ADD COLUMN IF NOT EXISTS cached_resources JSONB DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS cached_at TIMESTAMPTZ;

-- Reusable EKS cluster admins per user
CREATE TABLE IF NOT EXISTS public.eks_admins (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(user_id, email)
);

ALTER TABLE public.eks_admins ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage their own eks admins"
  ON public.eks_admins FOR ALL TO authenticated
  USING (auth.uid() = user_id);
