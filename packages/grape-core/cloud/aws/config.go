package aws

import (
	"context"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
)

type AWSOptions struct {
	Region  string
	Profile string
}

func LoadConfig(ctx context.Context, opts AWSOptions) (aws.Config, error) {
	loaders := []func(*awsconfig.LoadOptions) error{
		awsconfig.WithRegion(opts.Region),
	}
	if opts.Profile != "" && opts.Profile != "default" {
		loaders = append(loaders, awsconfig.WithSharedConfigProfile(opts.Profile))
	}
	return awsconfig.LoadDefaultConfig(ctx, loaders...)
}
