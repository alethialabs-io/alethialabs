-- Integration catalog: stores metadata about each supported integration

CREATE TYPE public.integration_category AS ENUM ('git', 'cloud');
CREATE TYPE public.integration_auth_method AS ENUM ('oauth', 'iam_role', 'service_account', 'service_principal', 'ram_role');
CREATE TYPE public.integration_status AS ENUM ('active', 'coming_soon');

CREATE TABLE IF NOT EXISTS public.integrations (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    category integration_category NOT NULL,
    auth_method integration_auth_method NOT NULL,
    organization TEXT NOT NULL,
    icon_url TEXT NOT NULL,
    docs_url TEXT,
    support_url TEXT,
    privacy_url TEXT,
    status integration_status NOT NULL DEFAULT 'active',
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE public.integrations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can view integrations"
    ON public.integrations FOR SELECT
    TO authenticated
    USING (true);

INSERT INTO public.integrations (slug, name, description, category, auth_method, organization, icon_url, docs_url, support_url, privacy_url, status, sort_order) VALUES
('github',    'GitHub',                'Connect your GitHub account to access repositories for GitOps workflows and application templates.',    'git',   'oauth',             'GitHub, Inc.',          '/icons/github/github-32x32.png',       'https://docs.github.com',                               'https://support.github.com',                  'https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement', 'active',      10),
('gitlab',    'GitLab',                'Connect your GitLab account to access repositories for GitOps workflows and application templates.',    'git',   'oauth',             'GitLab Inc.',           '/icons/gitlab/gitlab-32x32.png',       'https://docs.gitlab.com',                               'https://about.gitlab.com/support/',           'https://about.gitlab.com/privacy/',                                                        'active',      20),
('bitbucket', 'Bitbucket',             'Connect your Bitbucket account to access repositories for GitOps workflows and application templates.', 'git',   'oauth',             'Atlassian',             '/icons/bitbucket/bitbucket-32x32.png', 'https://support.atlassian.com/bitbucket-cloud/',        'https://support.atlassian.com',               'https://www.atlassian.com/legal/privacy-policy',                                           'active',      30),
('aws',       'Amazon Web Services',   'Cross-account IAM role for EKS clusters, VPCs, and infrastructure provisioning.',                      'cloud', 'iam_role',          'Amazon Web Services',   '/aws/favicon_64x64.png',               'https://console.aws.amazon.com/iam/home#/roles',       NULL,                                          'https://aws.amazon.com/privacy/',                                                          'active',      40),
('gcp',       'Google Cloud Platform', 'Service account with Workload Identity Federation for GKE clusters and Google Cloud resources.',        'cloud', 'service_account',   'Google Cloud',          '/gcp/favicon_64x64.png',               'https://cloud.google.com/docs',                         'https://cloud.google.com/support',            'https://cloud.google.com/terms/cloud-privacy-notice',                                      'coming_soon', 50),
('azure',     'Microsoft Azure',       'Service principal with federated credentials for AKS clusters and Azure resources.',                    'cloud', 'service_principal', 'Microsoft',             '/azure/favicon_64x64.png',             'https://learn.microsoft.com/en-us/azure/',              'https://azure.microsoft.com/en-us/support/',  'https://privacy.microsoft.com/',                                                           'coming_soon', 60),
('alibaba',   'Alibaba Cloud',         'RAM role with cross-account access for ACK clusters and Alibaba Cloud resources.',                      'cloud', 'ram_role',          'Alibaba Group',         '/alibaba/favicon_64x64.png',           'https://www.alibabacloud.com/help',                     NULL,                                          'https://www.alibabacloud.com/help/en/platform-of-aliyun/latest/chinese-site-privacy-policy','coming_soon', 70);
