CREATE UNIQUE INDEX idx_workers_unique_cloud_name
  ON public.workers (name)
  WHERE mode = 'cloud-hosted';
