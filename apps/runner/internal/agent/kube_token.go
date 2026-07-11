// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"time"

	"github.com/Azure/azure-sdk-for-go/sdk/azcore/policy"
	"github.com/Azure/azure-sdk-for-go/sdk/azidentity"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/sts"
	"github.com/aws/smithy-go/middleware"
	smithyhttp "github.com/aws/smithy-go/transport/http"
	"golang.org/x/oauth2/google"
)

// kube-token is the runner-as-Kubernetes-exec-credential-plugin. The kubeconfigs the
// runner writes (packages/core/cloud.writeExecKubeconfig) invoke `<runner> kube-token
// --provider <cloud> …`; this mints a short-lived cluster credential in-process from the
// already-active keyless cloud credentials (env + RO-mounted OIDC token files) and prints
// a client.authentication.k8s.io/v1beta1 ExecCredential. This replaces the per-cloud CLIs
// (aws-iam-authenticator / gcloud+gke-gcloud-auth-plugin / az+kubelogin) that used to live
// in the runner images. kubectl/helm re-invoke it on expiry, so short TTLs auto-refresh.

const (
	// EKS presigned-STS token: prefix + the base64url-no-pad presigned GetCallerIdentity URL.
	eksTokenPrefix    = "k8s-aws-v1."
	eksClusterHeader  = "x-k8s-aws-id"
	eksTokenTTL       = 14 * time.Minute // presign is valid ~15m; refresh a minute early
	gkeScope          = "https://www.googleapis.com/auth/cloud-platform"
	aksAADServerScope = "6dae42f8-4368-4678-94ff-3960e28e3630/.default" // the AKS AAD server app
)

// execCredential is the v1beta1 ExecCredential kubectl/client-go expects on stdout.
type execCredential struct {
	APIVersion string               `json:"apiVersion"`
	Kind       string               `json:"kind"`
	Status     execCredentialStatus `json:"status"`
}

type execCredentialStatus struct {
	Token               string `json:"token"`
	ExpirationTimestamp string `json:"expirationTimestamp,omitempty"`
}

// RunKubeToken parses the kube-token flags, mints a token for the requested provider, and
// prints the ExecCredential JSON to stdout. Invoked as a one-shot subcommand from main.
func RunKubeToken(ctx context.Context, args []string) error {
	fs := flag.NewFlagSet("kube-token", flag.ContinueOnError)
	provider := fs.String("provider", "", "cloud provider (aws|gcp|azure)")
	cluster := fs.String("cluster", "", "cluster name/id (AWS: bound into the token via x-k8s-aws-id)")
	region := fs.String("region", "", "cloud region (AWS)")
	if err := fs.Parse(args); err != nil {
		return err
	}

	var token string
	var exp time.Time
	var err error
	switch *provider {
	case "aws":
		token, exp, err = mintAWSEKSToken(ctx, *cluster, *region)
	case "gcp":
		token, exp, err = mintGCPToken(ctx)
	case "azure":
		token, exp, err = mintAzureToken(ctx)
	default:
		return fmt.Errorf("kube-token: unsupported provider %q (want aws|gcp|azure)", *provider)
	}
	if err != nil {
		return fmt.Errorf("kube-token %s: %w", *provider, err)
	}

	cred := execCredential{
		APIVersion: "client.authentication.k8s.io/v1beta1",
		Kind:       "ExecCredential",
		Status: execCredentialStatus{
			Token:               token,
			ExpirationTimestamp: exp.UTC().Format(time.RFC3339),
		},
	}
	return json.NewEncoder(os.Stdout).Encode(cred)
}

// eksClusterHeaderMiddleware injects the x-k8s-aws-id header into the request during the
// Build step, BEFORE SigV4 presigning, so the header is part of the signed SignedHeaders —
// which is exactly what the EKS token validator requires. Setting the header after presign
// (or on the output request) would leave it unsigned and the token would be rejected.
type eksClusterHeaderMiddleware struct{ clusterID string }

func (m *eksClusterHeaderMiddleware) ID() string { return "AlethiaEKSClusterHeader" }

func (m *eksClusterHeaderMiddleware) HandleBuild(
	ctx context.Context, in middleware.BuildInput, next middleware.BuildHandler,
) (middleware.BuildOutput, middleware.Metadata, error) {
	if req, ok := in.Request.(*smithyhttp.Request); ok {
		req.Header.Set(eksClusterHeader, m.clusterID)
	}
	return next.HandleBuild(ctx, in)
}

// mintAWSEKSToken produces the EKS bearer token: a presigned STS GetCallerIdentity URL with
// the x-k8s-aws-id header signed in, base64url-no-pad encoded behind the k8s-aws-v1. prefix.
// Equivalent to `aws-iam-authenticator token -i <cluster>` / `aws eks get-token`, but wholly
// in-process (offline signing — no STS network call) using the runner's keyless AWS creds.
func mintAWSEKSToken(ctx context.Context, clusterName, region string) (string, time.Time, error) {
	if clusterName == "" {
		return "", time.Time{}, fmt.Errorf("--cluster is required")
	}
	cfg, err := awsconfig.LoadDefaultConfig(ctx, awsconfig.WithRegion(region))
	if err != nil {
		return "", time.Time{}, fmt.Errorf("load AWS config: %w", err)
	}
	presign := sts.NewPresignClient(sts.NewFromConfig(cfg))
	out, err := presign.PresignGetCallerIdentity(ctx, &sts.GetCallerIdentityInput{}, func(o *sts.PresignOptions) {
		o.ClientOptions = append(o.ClientOptions, func(so *sts.Options) {
			so.APIOptions = append(so.APIOptions, func(stack *middleware.Stack) error {
				return stack.Build.Add(&eksClusterHeaderMiddleware{clusterID: clusterName}, middleware.After)
			})
		})
	})
	if err != nil {
		return "", time.Time{}, fmt.Errorf("presign GetCallerIdentity: %w", err)
	}
	token := eksTokenPrefix + base64.RawURLEncoding.EncodeToString([]byte(out.URL))
	return token, time.Now().Add(eksTokenTTL), nil
}

// mintGCPToken returns a GKE bearer token — a cloud-platform-scoped OAuth2 access token from
// the keyless Workload Identity Federation credentials (GOOGLE_APPLICATION_CREDENTIALS →
// external_account → impersonation via sts.googleapis.com + iamcredentials.googleapis.com).
// Replaces gcloud + gke-gcloud-auth-plugin.
func mintGCPToken(ctx context.Context) (string, time.Time, error) {
	creds, err := google.FindDefaultCredentials(ctx, gkeScope)
	if err != nil {
		return "", time.Time{}, fmt.Errorf("find GCP credentials: %w", err)
	}
	tok, err := creds.TokenSource.Token()
	if err != nil {
		return "", time.Time{}, fmt.Errorf("obtain GCP access token: %w", err)
	}
	return tok.AccessToken, tok.Expiry, nil
}

// mintAzureToken returns an AKS AAD bearer token via the workload-identity federated
// assertion already on disk (AZURE_FEDERATED_TOKEN_FILE + AZURE_CLIENT_ID/TENANT_ID env,
// read by NewWorkloadIdentityCredential). A short-lived AAD token — no long-lived admin
// cert. Replaces az + kubelogin.
func mintAzureToken(ctx context.Context) (string, time.Time, error) {
	cred, err := azidentity.NewWorkloadIdentityCredential(nil)
	if err != nil {
		return "", time.Time{}, fmt.Errorf("azure workload identity credential: %w", err)
	}
	tok, err := cred.GetToken(ctx, policy.TokenRequestOptions{Scopes: []string{aksAADServerScope}})
	if err != nil {
		return "", time.Time{}, fmt.Errorf("obtain AKS AAD token: %w", err)
	}
	return tok.Token, tok.ExpiresOn, nil
}
