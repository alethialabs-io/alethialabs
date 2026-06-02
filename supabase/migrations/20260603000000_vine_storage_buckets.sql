CREATE TABLE public.vine_storage_buckets (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    vine_id UUID NOT NULL REFERENCES public.vines(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    versioning BOOLEAN DEFAULT false,
    encryption TEXT DEFAULT 'AES256',
    public_access BOOLEAN DEFAULT false,
    cors_origins TEXT[] DEFAULT '{}',
    status public.component_status DEFAULT 'PENDING',
    status_message TEXT,
    estimated_monthly_cost NUMERIC(10,2),
    created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT now() NOT NULL,

    CONSTRAINT vine_storage_buckets_name_unique UNIQUE (vine_id, name)
);

ALTER TABLE public.vine_storage_buckets ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own vine_storage_buckets" ON public.vine_storage_buckets
  FOR ALL
  USING (vine_id IN (SELECT id FROM public.vines WHERE user_id = auth.uid()))
  WITH CHECK (vine_id IN (SELECT id FROM public.vines WHERE user_id = auth.uid()));

CREATE TRIGGER vine_storage_buckets_updated_at BEFORE UPDATE ON public.vine_storage_buckets
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();
