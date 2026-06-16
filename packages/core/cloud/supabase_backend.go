// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cloud

import (
	"fmt"
	"os"
	"path/filepath"
)

const (
	DefaultSupabaseS3Endpoint = "https://egzejziajjmjmdjplmii.storage.supabase.co/storage/v1/s3"
	DefaultSupabaseS3Region   = "eu-north-1"
	DefaultStateBucket        = "vine-terraform-state"
)

type SupabaseBackendConfig struct {
	Endpoint  string
	Region    string
	AccessKey string
	SecretKey string
	Bucket    string
}

func NewSupabaseBackendFromEnv() *SupabaseBackendConfig {
	endpoint := os.Getenv("SUPABASE_S3_ENDPOINT")
	if endpoint == "" {
		endpoint = DefaultSupabaseS3Endpoint
	}
	region := os.Getenv("SUPABASE_S3_REGION")
	if region == "" {
		region = DefaultSupabaseS3Region
	}
	return &SupabaseBackendConfig{
		Endpoint:  endpoint,
		Region:    region,
		AccessKey: os.Getenv("SUPABASE_STORAGE_KEY_ID"),
		SecretKey: os.Getenv("SUPABASE_STORAGE_SECRET_KEY"),
		Bucket:    DefaultStateBucket,
	}
}

func SupabaseBackendFromConfig(endpoint, region, accessKey, secretKey string) *SupabaseBackendConfig {
	if endpoint == "" {
		endpoint = DefaultSupabaseS3Endpoint
	}
	if region == "" {
		region = DefaultSupabaseS3Region
	}
	return &SupabaseBackendConfig{
		Endpoint:  endpoint,
		Region:    region,
		AccessKey: accessKey,
		SecretKey: secretKey,
		Bucket:    DefaultStateBucket,
	}
}

// WriteBackendHCL writes a backend.hcl file for terraform init -backend-config=<file>.
func (c *SupabaseBackendConfig) WriteBackendHCL(dir, vineyardID, projectName, environment, region string) (string, error) {
	key := fmt.Sprintf("%s/%s-%s-%s/terraform.tfstate", vineyardID, projectName, environment, region)
	return c.writeHCL(dir, key)
}

// WriteWorkerBackendHCL writes a backend.hcl for worker self-deploy state.
func (c *SupabaseBackendConfig) WriteWorkerBackendHCL(dir, workerID string) (string, error) {
	key := fmt.Sprintf("workers/%s/terraform.tfstate", workerID)
	return c.writeHCL(dir, key)
}

func (c *SupabaseBackendConfig) writeHCL(dir, key string) (string, error) {
	content := fmt.Sprintf(`bucket                      = %q
key                         = %q
region                      = %q
access_key                  = %q
secret_key                  = %q
endpoints                   = { s3 = %q }
skip_credentials_validation = true
skip_requesting_account_id  = true
skip_metadata_api_check     = true
skip_region_validation      = true
skip_s3_checksum            = true
use_path_style              = true
use_lockfile                = true
`, c.Bucket, key, c.Region, c.AccessKey, c.SecretKey, c.Endpoint)

	path := filepath.Join(dir, "backend.hcl")
	if err := os.WriteFile(path, []byte(content), 0600); err != nil {
		return "", fmt.Errorf("failed to write backend.hcl: %w", err)
	}
	return path, nil
}
