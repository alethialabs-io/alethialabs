-- Enrich worker_releases with release metadata

ALTER TABLE public.worker_releases
    ADD COLUMN github_release_url TEXT,
    ADD COLUMN commit_sha TEXT,
    ADD COLUMN is_breaking BOOLEAN NOT NULL DEFAULT false;
