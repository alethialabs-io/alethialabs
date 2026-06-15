// SPDX-FileCopyrightText: 2026 Alethia OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package aws

import (
	"context"
	"errors"
	"fmt"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"
)

type S3Client struct {
	*s3.Client
}

func NewS3Client(ctx context.Context, opts AWSOptions) (*S3Client, error) {
	cfg, err := LoadConfig(ctx, opts)
	if err != nil {
		return nil, fmt.Errorf("failed to load AWS config: %w", err)
	}
	return &S3Client{Client: s3.NewFromConfig(cfg)}, nil
}

func (c *S3Client) CreateS3BucketIfNotExists(ctx context.Context, bucketName string, region string, dryRun bool) error {
	_, err := c.HeadBucket(ctx, &s3.HeadBucketInput{
		Bucket: &bucketName,
	})

	if err != nil {
		var nfe *types.NotFound
		if errors.As(err, &nfe) {
			// Bucket does not exist, so create it
			fmt.Printf("Creating bucket '%s' in region %s...\n", bucketName, region)

			if dryRun {
				fmt.Println("Dry-run mode: Skipping actual creation of bucket.")
				return nil
			}

			createBucketInput := &s3.CreateBucketInput{
				Bucket: &bucketName,
				CreateBucketConfiguration: &types.CreateBucketConfiguration{
					LocationConstraint: types.BucketLocationConstraint(region),
				},
			}

			_, err = c.CreateBucket(ctx, createBucketInput)
			if err != nil {
				return fmt.Errorf("failed to create bucket '%s': %w", bucketName, err)
			}

			if err := c.hardenBucket(ctx, bucketName); err != nil {
				fmt.Printf("Warning: bucket '%s' created but some security settings failed: %v\n", bucketName, err)
			}

			fmt.Printf("Bucket '%s' created successfully.\n", bucketName)
			return nil
		}
		// An error other than "NotFound" occurred
		return fmt.Errorf("failed to check for bucket '%s': %w", bucketName, err)
	}

	// Bucket already exists
	fmt.Printf("Bucket '%s' already exists.\n", bucketName)
	return nil
}

func (c *S3Client) hardenBucket(ctx context.Context, bucketName string) error {
	_, err := c.PutPublicAccessBlock(ctx, &s3.PutPublicAccessBlockInput{
		Bucket: &bucketName,
		PublicAccessBlockConfiguration: &types.PublicAccessBlockConfiguration{
			BlockPublicAcls:       aws.Bool(true),
			BlockPublicPolicy:     aws.Bool(true),
			IgnorePublicAcls:      aws.Bool(true),
			RestrictPublicBuckets: aws.Bool(true),
		},
	})
	if err != nil {
		return fmt.Errorf("failed to set public access block: %w", err)
	}

	_, err = c.PutBucketEncryption(ctx, &s3.PutBucketEncryptionInput{
		Bucket: &bucketName,
		ServerSideEncryptionConfiguration: &types.ServerSideEncryptionConfiguration{
			Rules: []types.ServerSideEncryptionRule{{
				ApplyServerSideEncryptionByDefault: &types.ServerSideEncryptionByDefault{
					SSEAlgorithm: types.ServerSideEncryptionAes256,
				},
				BucketKeyEnabled: aws.Bool(true),
			}},
		},
	})
	if err != nil {
		return fmt.Errorf("failed to enable encryption: %w", err)
	}

	_, err = c.PutBucketVersioning(ctx, &s3.PutBucketVersioningInput{
		Bucket: &bucketName,
		VersioningConfiguration: &types.VersioningConfiguration{
			Status: types.BucketVersioningStatusEnabled,
		},
	})
	if err != nil {
		return fmt.Errorf("failed to enable versioning: %w", err)
	}

	_, err = c.PutBucketOwnershipControls(ctx, &s3.PutBucketOwnershipControlsInput{
		Bucket: &bucketName,
		OwnershipControls: &types.OwnershipControls{
			Rules: []types.OwnershipControlsRule{{
				ObjectOwnership: types.ObjectOwnershipBucketOwnerEnforced,
			}},
		},
	})
	if err != nil {
		return fmt.Errorf("failed to set ownership controls: %w", err)
	}

	return nil
}
