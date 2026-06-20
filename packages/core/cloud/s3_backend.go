// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cloud

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	s3types "github.com/aws/aws-sdk-go-v2/service/s3/types"
)

const (
	DefaultS3Region    = "us-east-1"
	DefaultStateBucket = "spec-tofu-state"
)

// S3BackendConfig describes an S3-compatible state backend (SeaweedFS / Garage /
// MinIO / AWS S3 / R2). The endpoint is operator-supplied — there is no default
// SaaS endpoint, which is what keeps the control plane self-hostable.
type S3BackendConfig struct {
	Endpoint  string
	Region    string
	AccessKey string
	SecretKey string
	Bucket    string
}

func NewS3BackendFromEnv() *S3BackendConfig {
	region := os.Getenv("ALETHIA_STORAGE_REGION")
	if region == "" {
		region = DefaultS3Region
	}
	return &S3BackendConfig{
		Endpoint:  os.Getenv("ALETHIA_STORAGE_ENDPOINT"),
		Region:    region,
		AccessKey: os.Getenv("ALETHIA_STORAGE_ACCESS_KEY_ID"),
		SecretKey: os.Getenv("ALETHIA_STORAGE_SECRET_ACCESS_KEY"),
		Bucket:    DefaultStateBucket,
	}
}

func S3BackendFromConfig(endpoint, region, accessKey, secretKey string) *S3BackendConfig {
	if region == "" {
		region = DefaultS3Region
	}
	return &S3BackendConfig{
		Endpoint:  endpoint,
		Region:    region,
		AccessKey: accessKey,
		SecretKey: secretKey,
		Bucket:    DefaultStateBucket,
	}
}

// s3API builds an S3 client against the configured S3-compatible endpoint with
// static credentials and path-style addressing (SeaweedFS / MinIO / Garage / S3).
func (c *S3BackendConfig) s3API() *s3.Client {
	return s3.New(s3.Options{
		Region:       c.Region,
		Credentials:  credentials.NewStaticCredentialsProvider(c.AccessKey, c.SecretKey, ""),
		BaseEndpoint: aws.String(c.Endpoint),
		UsePathStyle: true,
	})
}

// EnsureBucket makes sure the state bucket exists before `tofu init` —
// OpenTofu's s3 backend will not create it. Idempotent and safe to call every
// run. A no-op (beyond a HEAD check) when ALETHIA_STORAGE_AUTO_CREATE_BUCKETS is false,
// where a managed S3 is expected to be pre-provisioned.
func (c *S3BackendConfig) EnsureBucket(ctx context.Context) error {
	if c.Bucket == "" {
		return fmt.Errorf("state bucket name is empty")
	}
	client := c.s3API()

	if _, err := client.HeadBucket(ctx, &s3.HeadBucketInput{Bucket: &c.Bucket}); err == nil {
		return nil
	} else if !autoCreateBuckets() {
		return fmt.Errorf("state bucket %q not found and ALETHIA_STORAGE_AUTO_CREATE_BUCKETS is disabled: %w", c.Bucket, err)
	}

	if _, err := client.CreateBucket(ctx, &s3.CreateBucketInput{Bucket: &c.Bucket}); err != nil {
		var owned *s3types.BucketAlreadyOwnedByYou
		var exists *s3types.BucketAlreadyExists
		if errors.As(err, &owned) || errors.As(err, &exists) {
			return nil
		}
		return fmt.Errorf("failed to create state bucket %q: %w", c.Bucket, err)
	}
	return nil
}

// autoCreateBuckets reports whether the app may create missing buckets (default true).
func autoCreateBuckets() bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv("ALETHIA_STORAGE_AUTO_CREATE_BUCKETS"))) {
	case "false", "0", "no", "off":
		return false
	default:
		return true
	}
}

// WriteBackendHCL writes a backend.hcl file for tofu init -backend-config=<file>.
func (c *S3BackendConfig) WriteBackendHCL(dir, zoneID, projectName, environment, region string) (string, error) {
	key := fmt.Sprintf("%s/%s-%s-%s/tofu.tfstate", zoneID, projectName, environment, region)
	return c.writeHCL(dir, key)
}

// WriteRunnerBackendHCL writes a backend.hcl for runner self-deploy state.
func (c *S3BackendConfig) WriteRunnerBackendHCL(dir, runnerID string) (string, error) {
	key := fmt.Sprintf("runners/%s/tofu.tfstate", runnerID)
	return c.writeHCL(dir, key)
}

func (c *S3BackendConfig) writeHCL(dir, key string) (string, error) {
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
