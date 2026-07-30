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
	"strings"
	"time"

	"github.com/Azure/azure-sdk-for-go/sdk/azcore"
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
	eksTokenPrefix   = "k8s-aws-v1."
	eksClusterHeader = "x-k8s-aws-id"
	eksTokenTTL      = 14 * time.Minute // presign is valid 15m (eksPresignExpires); refresh a minute early
	// eksPresignExpires is the X-Amz-Expires (seconds) stamped on the presigned GetCallerIdentity
	// URL. The v4 presigner sets NO default expiry, and EKS rejects a token whose presign carries no
	// valid X-Amz-Expires (#1040 — a green apply then a hard 401). 900s is the EKS maximum and covers
	// the ~14m token TTL so a cached token never outlives its presign window.
	eksPresignExpires = "900"
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
	case "alibaba":
		// ACK does NOT use an exec-plugin bearer model (unlike EKS/GKE/AKS). Its
		// DescribeClusterUserKubeconfig returns a COMPLETE kubeconfig with an embedded, short-lived x509
		// client cert, which alibabaProvider.ConfigureKubeconfig resolves output-free (keyless RRSA
		// signing) and writes verbatim — so kubectl authenticates directly with no `kube-token` callout.
		// Recognized here (not the opaque default) so a stray invocation fails with the reason rather than
		// looking like an unknown provider: for ACK this is by design, not a gap.
		return fmt.Errorf("kube-token: provider %q has no exec-plugin token — ACK writes a client-cert kubeconfig directly (see alibabaProvider.ConfigureKubeconfig); kube-token is not used for alibaba", *provider)
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

// eksClusterHeaderMiddleware prepares the request for EKS presigning during the Build step, BEFORE
// SigV4 presigning, so both mutations are part of the signature the EKS token validator checks:
//   - injects the x-k8s-aws-id header (must be a signed SignedHeader — binds the token to the cluster);
//   - sets the X-Amz-Expires query parameter, because the v4 presigner adds NO expiry by default and
//     EKS rejects a presign without a valid X-Amz-Expires (#1040).
//
// Doing either after presign (or on the output request) would leave it unsigned and the token rejected.
type eksClusterHeaderMiddleware struct{ clusterID string }

func (m *eksClusterHeaderMiddleware) ID() string { return "AlethiaEKSClusterHeader" }

func (m *eksClusterHeaderMiddleware) HandleBuild(
	ctx context.Context, in middleware.BuildInput, next middleware.BuildHandler,
) (middleware.BuildOutput, middleware.Metadata, error) {
	if req, ok := in.Request.(*smithyhttp.Request); ok {
		req.Header.Set(eksClusterHeader, m.clusterID)
		q := req.URL.Query()
		q.Set("X-Amz-Expires", eksPresignExpires)
		req.URL.RawQuery = q.Encode()
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
		// eksClusterHeaderMiddleware runs in the Build phase (before Finalize presigning) and sets
		// BOTH the signed x-k8s-aws-id header AND X-Amz-Expires — the two things EKS's token
		// validator requires. The presign client exposes no expiry option, so the expiry is set as
		// a request query param the same way (see the middleware + #1040).
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

// mintAzureToken returns a short-lived AKS AAD bearer token — no long-lived admin cert.
// Replaces az + kubelogin.
//
// WORKLOAD IDENTITY FIRST, then whatever else the environment offers. The managed path
// (ActivateAzureFederated) writes AZURE_FEDERATED_TOKEN_FILE + AZURE_CLIENT_ID/TENANT_ID, so
// the first link resolves exactly as it always has and that behaviour is unchanged.
//
// The fallback exists because this used to be workload-identity ONLY, which made Azure the
// odd cloud out: mintGCPToken uses google.FindDefaultCredentials and the AWS path resolves
// ambient config, so both work for a runner holding ordinary credentials. Azure did not —
// every non-pod runner died with "no client ID specified", including a self-hosted runner
// using a service principal, an operator on `az login`, and the T2 harness (which passes a
// nil cloud_identity precisely so the runner uses ambient creds). The cluster would provision
// and then be unreachable, which reads as a broken cluster rather than a credential gap.
//
// Chained rather than DefaultAzureCredential alone: Default puts EnvironmentCredential ahead
// of workload identity, so an AZURE_CLIENT_SECRET left in a pod's environment would silently
// take precedence over the federated assertion. Pinning workload identity first keeps the
// managed runner's identity unambiguous.
func mintAzureToken(ctx context.Context) (string, time.Time, error) {
	var creds []azcore.TokenCredential
	var reasons []string

	if wi, err := azidentity.NewWorkloadIdentityCredential(nil); err == nil {
		creds = append(creds, wi)
	} else {
		reasons = append(reasons, "workload-identity: "+err.Error())
	}
	if def, err := azidentity.NewDefaultAzureCredential(nil); err == nil {
		creds = append(creds, def)
	} else {
		reasons = append(reasons, "default-chain: "+err.Error())
	}
	if len(creds) == 0 {
		return "", time.Time{}, fmt.Errorf("no usable azure credential (%s)", strings.Join(reasons, "; "))
	}

	chain, err := azidentity.NewChainedTokenCredential(creds, nil)
	if err != nil {
		return "", time.Time{}, fmt.Errorf("azure credential chain: %w", err)
	}
	tok, err := chain.GetToken(ctx, policy.TokenRequestOptions{Scopes: []string{aksAADServerScope}})
	if err != nil {
		return "", time.Time{}, fmt.Errorf("obtain AKS AAD token: %w", err)
	}
	return tok.Token, tok.ExpiresOn, nil
}
