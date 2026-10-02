// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/netip"
	"net/url"
	"strings"
	"time"

	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/eks"

	"github.com/alethialabs-io/alethialabs/packages/core/cloud"
	coreaws "github.com/alethialabs-io/alethialabs/packages/core/cloud/aws"
	"github.com/alethialabs-io/alethialabs/packages/core/kubeaccess"
	"github.com/alethialabs-io/alethialabs/packages/core/provisioner"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// MINT_KUBECONFIG (#5283; design and decisions 1–8 in #5250, contract #5292, read-only tier #5304,
// routes #5306). The runner mints a short-lived kubeconfig credential for ONE cluster, in-network,
// seals it to the requesting client's ephemeral X25519 key and posts the ciphertext over the one-shot
// result channel. The console never sees the plaintext.
//
//	1. GET the spec (mint id, cluster id, tier, shape, ttl, client public key).
//	2. Get the cluster's ADMIN connection with the cloud's existing minter — held in memory only:
//	     aws      EKS DescribeCluster (endpoint, CA) + the presigned-STS token   (kube_token.go)
//	     gcp      GKE clusters.get     (endpoint, CA) + the WIF access token      (kube_conn_resolver.go)
//	     azure    AKS ARM get          (endpoint, CA) + the AAD token             (kube_conn_resolver.go)
//	     alibaba  ACK DescribeClusterUserKubeconfig, TemporaryDurationMinutes = TTL (x509 client cert)
//	     hetzner  Talos apid Kubeconfig from the Fabric's talosconfig, SSRF-guarded (talos_kubeconfig.go)
//	3. readonly: EnsureReadOnlyAccess + a TokenRequest for TTL on the alethia-view ServiceAccount, using
//	   the admin connection (packages/core/kubeaccess). admin: the cloud credential itself.
//	4. Classify the endpoint as the USER would see it (public DNS), into private_endpoint.
//	5. Seal a KubeconfigMintCredential bound to (mint id, cluster id) and POST it; on any failure POST
//	   `failed` with one sentence from the fixed set below.
//
// NOTHING CREDENTIAL-SHAPED LEAVES THIS FILE except inside the sealed blob. No token, key, kubeconfig
// or talosconfig reaches execution_metadata (this handler posts none), a job log, an operational log
// line, or an error: a cloud SDK's error text can carry a presigned URL or a response body, so every
// failure is reduced to a fixed sentence and the underlying error is reported only by its TYPE and,
// for a Kubernetes API answer, its status code (describeMintCause). kubeconfig_mint_canary_test.go
// drives every path with a canary credential and asserts it surfaces nowhere.

// The failure sentences, byte for byte as apps/console/lib/kubeconfig-mint/reasons.ts has them. The
// console stores a posted reason only when it EXACTLY matches one of these and replaces anything else
// with mintReasonUnknown. TestMintFailureReasons_MatchTheConsoleList pins this list to the TS file.
const (
	mintReasonUnknown       = "The runner could not mint the credential."
	mintReasonNotFound      = "The cluster was not found in the cloud account."
	mintReasonUnreachable   = "The runner could not reach the cluster's API endpoint."
	mintReasonIdentity      = "The runner could not assume the cluster's cloud identity."
	mintReasonRefused       = "The cloud refused to issue a credential for this cluster."
	mintReasonReadOnly      = "The read-only identity could not be prepared in the cluster."
	mintReasonShape         = "This cloud cannot issue the requested kubeconfig shape."
	mintReasonSeal          = "The runner could not seal the credential to the client key."
	mintReasonSharedCluster = "Kubeconfig mints are not available for an environment placed on a shared cluster."
)

// mintFailureReasons is every sentence above, in the TS file's order.
var mintFailureReasons = []string{
	mintReasonUnknown,
	mintReasonNotFound,
	mintReasonUnreachable,
	mintReasonIdentity,
	mintReasonRefused,
	mintReasonReadOnly,
	mintReasonShape,
	mintReasonSeal,
	mintReasonSharedCluster,
}

// Errors the handler returns WITHOUT a mint failure to post. Their text is fixed: the dispatcher puts
// a returned error into the job's error_message, the job's STDERR log and Sentry.
var (
	// errMintChannelUnavailable: the JobAPI in use has no result channel, so nothing can be delivered.
	errMintChannelUnavailable = errors.New("this runner's job API has no kubeconfig mint channel; nothing was minted")
	// errMintSpecUnreadable: the spec could not be read (network, or an invalid answer). Without the
	// spec there is no mint id to post a failure against, so the job fails and the console's poll
	// reports the generic reason for a dead job.
	errMintSpecUnreadable = errors.New("the runner could not read the kubeconfig mint spec; nothing was minted")
	// errMintNotDelivered: the result post failed for a reason other than a console refusal.
	errMintNotDelivered = errors.New("the runner could not deliver the kubeconfig mint result; the credential was discarded")
)

// kubeconfigMintTimeout bounds the whole mint. The console's poll window is 10 minutes from the
// request, and part of it is spent queued; a mint that cannot finish in this budget would be posted
// into a closed window anyway.
const kubeconfigMintTimeout = 5 * time.Minute

// mintPublicDNSServer is the resolver the endpoint is classified through: the runner runs INSIDE the
// cluster's network, where split-horizon DNS answers differently from what the user will see
// (kubeaccess.PublicDNSResolver).
const mintPublicDNSServer = "1.1.1.1:53"

// ackReadOnlySetupMinutes is the lifetime of the ACK admin certificate the read-only tier uses only
// to create its identity: ACK's floor, because nothing else ever holds it.
const ackReadOnlySetupMinutes = cloud.ACKTempKubeconfigMinMinutes

// mintFailure is a failed mint. Its Error() is EXACTLY one fixed sentence — so it can be posted,
// returned to the dispatcher and logged as-is — and the stage and cause are non-secret descriptions
// for the runner's operational log.
type mintFailure struct {
	reason string
	stage  string
	cause  string
}

// Error returns the fixed sentence, never the cause.
func (f *mintFailure) Error() string { return f.reason }

// failMint builds a mintFailure, reducing cause to its non-secret description.
func failMint(reason, stage string, cause error) *mintFailure {
	return &mintFailure{reason: reason, stage: stage, cause: describeMintCause(cause)}
}

// describeMintCause names an error WITHOUT quoting it: its Go type and, for a Kubernetes API answer,
// the HTTP status. A cloud SDK error's text can carry a presigned URL, a response body or a token, so
// its text is never used.
func describeMintCause(err error) string {
	if err == nil {
		return ""
	}
	var apiErr *kubeaccess.APIError
	if errors.As(err, &apiErr) {
		return fmt.Sprintf("kubernetes api status %d", apiErr.Code)
	}
	var urlErr *url.Error
	if errors.As(err, &urlErr) {
		return "transport error (" + fmt.Sprintf("%T", urlErr.Err) + ")"
	}
	return fmt.Sprintf("%T", err)
}

// adminConn is a cluster's admin connection: the pinned endpoint and CA plus ONE credential — a
// bearer token (aws, gcp, azure) or a client certificate (alibaba, hetzner). In memory only.
type adminConn struct {
	server string
	caData string
	// token and tokenExpiry are the bearer credential and its real expiry.
	token       string
	tokenExpiry time.Time
	// cert is the certificate credential, with its real NotAfter.
	cert *adminCertConn
}

// kubeConn is the kubeaccess.Conn the read-only tier's setup calls go through.
func (a adminConn) kubeConn() kubeaccess.Conn {
	conn := kubeaccess.Conn{Server: a.server, CAData: a.caData}
	if a.cert != nil {
		conn.ClientCertData, conn.ClientKeyData = a.cert.ClientCertData, a.cert.ClientKeyData
	} else {
		conn.Token = a.token
	}
	return conn
}

// mintSeams are the cloud and cluster calls a mint makes, injectable so every cloud and tier is
// testable without a cloud or a cluster. defaultMintSeams wires the real minters.
type mintSeams struct {
	// readOutputs reads the environment's tofu outputs (only to learn the cluster's name when the
	// snapshot does not carry it). The outputs can hold sensitive values; they stay in memory.
	readOutputs func(ctx context.Context, w *Runner, job *Job, vc *types.ProjectConfig, stdout, stderr *JobLogger) (map[string]any, error)
	eksConn     func(ctx context.Context, region, clusterName string) (server, caData string, err error)
	eksToken    func(ctx context.Context, clusterName, region string) (string, time.Time, error)
	gkeConn     func(ctx context.Context, vc *types.ProjectConfig, clusterName string) (string, string, error)
	gkeToken    func(ctx context.Context) (string, time.Time, error)
	aksConn     func(ctx context.Context, vc *types.ProjectConfig, clusterName string) (string, string, error)
	aksToken    func(ctx context.Context) (string, time.Time, error)
	// ackKubeconfig returns ACK's user kubeconfig with a client certificate valid for `minutes`.
	ackKubeconfig func(ctx context.Context, region, clusterName string, minutes int) (string, error)
	// talosKubeconfig mints a Talos admin kubeconfig from the talosconfig (with its SSRF guard).
	talosKubeconfig func(ctx context.Context, talosconfig string) ([]byte, error)
	// newKube builds the Kubernetes API client the read-only tier's setup calls use.
	newKube func(conn kubeaccess.Conn) (kubeaccess.KubeAPI, error)
	// lookupIP resolves a host for the dial guard (the runner's own resolver: it is what will dial).
	lookupIP func(ctx context.Context, host string) ([]netip.Addr, error)
	// resolver classifies the endpoint as the user would see it.
	resolver kubeaccess.Resolver
}

// defaultMintSeams wires the real, existing minters. Nothing here is a second implementation of one.
func defaultMintSeams() mintSeams {
	return mintSeams{
		readOutputs: func(ctx context.Context, w *Runner, job *Job, vc *types.ProjectConfig, stdout, stderr *JobLogger) (map[string]any, error) {
			sb, err := w.stateBackend(job.ID)
			if err != nil {
				return nil, err
			}
			return provisioner.ReadStateOutputs(ctx, provisioner.ReadStateOutputsParams{
				IacVersion: vc.IacVersion, StateBackend: sb, Stdout: stdout, Stderr: stderr,
			})
		},
		eksConn: func(ctx context.Context, region, clusterName string) (string, string, error) {
			cfg, err := awsconfig.LoadDefaultConfig(ctx, awsconfig.WithRegion(region))
			if err != nil {
				return "", "", err
			}
			conn, err := coreaws.ResolveEKSClusterConn(ctx, eks.NewFromConfig(cfg), clusterName)
			if err != nil {
				return "", "", err
			}
			return conn.Endpoint, conn.CAData, nil
		},
		eksToken:        mintAWSEKSToken,
		gkeConn:         resolveGKEConn,
		gkeToken:        mintGCPToken,
		aksConn:         resolveAKSConn,
		aksToken:        mintAzureToken,
		ackKubeconfig:   cloud.ResolveACKTemporaryKubeconfig,
		talosKubeconfig: MintTalosKubeconfig,
		newKube: func(conn kubeaccess.Conn) (kubeaccess.KubeAPI, error) {
			return kubeaccess.NewClient(conn)
		},
		lookupIP: func(ctx context.Context, host string) ([]netip.Addr, error) {
			return net.DefaultResolver.LookupNetIP(ctx, "ip", host)
		},
		resolver: kubeaccess.PublicDNSResolver(mintPublicDNSServer),
	}
}

// kubeconfigMintSeams is the seam set executeMintKubeconfig uses. Tests replace it.
var kubeconfigMintSeams = defaultMintSeams()

// executeMintKubeconfig handles a MINT_KUBECONFIG job end to end (see the file comment). It returns
// nil when the result was delivered — the console completes the job in the same transaction — and
// otherwise an error whose text is fixed (a mint failure's sentence, or one of the sentinels above),
// because the dispatcher writes it to error_message, the job log and Sentry. A 403 from the console
// wraps ErrJobNotOwned, which the dispatcher treats as "stop, post nothing".
func (w *Runner) executeMintKubeconfig(ctx context.Context, job *Job, provider string, identity *CloudIdentity, stdout, stderr *JobLogger) error {
	mapi, ok := w.api.(kubeconfigMintAPI)
	if !ok {
		return errMintChannelUnavailable
	}
	olog := LogWith(w.config.RunnerID, traceIDFromTraceparent(job.Traceparent), job.ID).With("op", "kubeconfig_mint")

	spec, err := mapi.FetchKubeconfigMintSpec(job.ID)
	if err != nil {
		return w.endMintOnRefusal(olog, "read spec", err, errMintSpecUnreadable)
	}

	ctx, cancel := context.WithTimeout(ctx, kubeconfigMintTimeout)
	defer cancel()

	fmt.Fprintf(stdout, "▸ Minting a %s %s kubeconfig credential (TTL %s)…\n", spec.Tier, spec.Shape, time.Duration(spec.TTLSeconds)*time.Second)
	cred, private, failure := w.mintCredential(ctx, job, provider, identity, spec, kubeconfigMintSeams, stdout, stderr)

	var sealed string
	if failure == nil {
		sealed, failure = sealMintCredential(spec, cred)
	}
	if failure != nil {
		olog.Warn("kubeconfig mint failed", "stage", failure.stage, "cause", failure.cause, "reason", failure.reason)
		fmt.Fprintf(stderr, "Kubeconfig mint failed: %s\n", failure.reason)
		postErr := mapi.PostKubeconfigMintResult(job.ID, types.RunnerKubeconfigMintResult{
			Status: types.KubeconfigMintStatusFailed, MintID: spec.MintID, Reason: failure.reason, PrivateEndpoint: private,
		})
		if postErr != nil {
			return w.endMintOnRefusal(olog, "post failure", postErr, failure)
		}
		return failure
	}

	if err := mapi.PostKubeconfigMintResult(job.ID, types.RunnerKubeconfigMintResult{
		Status: types.KubeconfigMintStatusReady, MintID: spec.MintID, Sealed: sealed, PrivateEndpoint: private,
	}); err != nil {
		return w.endMintOnRefusal(olog, "post result", err, errMintNotDelivered)
	}
	fmt.Fprintf(stdout, "Sealed the credential to the client's key and delivered it (expires %s).\n", cred.ExpiresAt.UTC().Format(time.RFC3339))
	if private != nil && *private {
		fmt.Fprintln(stdout, "The cluster's API endpoint is private: reaching it needs network access (VPN or bastion).")
	}
	return nil
}

// endMintOnRefusal turns a console answer into the job's ending. A 409 (the mint already has a result)
// ends cleanly; a 410 (window closed) and a 404 (mint gone) end with their fixed sentinel; a 403 keeps
// its ErrJobNotOwned wrap so the dispatcher posts nothing; anything else ends with fallback.
func (w *Runner) endMintOnRefusal(olog *slog.Logger, stage string, err error, fallback error) error {
	switch {
	case errors.Is(err, errMintSettled):
		olog.Info("kubeconfig mint already has a result; ending", "stage", stage)
		return nil
	case errors.Is(err, errMintWindowClosed), errors.Is(err, errMintNotFound), errors.Is(err, ErrJobNotOwned):
		olog.Warn("console refused the kubeconfig mint", "stage", stage, "cause", describeMintCause(err))
		if errors.Is(err, ErrJobNotOwned) {
			return err
		}
		if errors.Is(err, errMintWindowClosed) {
			return errMintWindowClosed
		}
		return errMintNotFound
	default:
		olog.Warn("kubeconfig mint channel error", "stage", stage, "cause", describeMintCause(err))
		return fallback
	}
}

// mintCredential produces the plaintext credential, or a mintFailure. private is the endpoint
// classification once the endpoint is known (nil before that, and when undecidable).
func (w *Runner) mintCredential(ctx context.Context, job *Job, provider string, identity *CloudIdentity, spec types.RunnerKubeconfigMintSpec, seams mintSeams, stdout, stderr *JobLogger) (types.KubeconfigMintCredential, *bool, *mintFailure) {
	var none types.KubeconfigMintCredential
	vc, err := snapshotToProjectConfig(job.ConfigSnapshot)
	if err != nil {
		return none, nil, failMint(mintReasonUnknown, "parse snapshot", err)
	}
	if provider == "" {
		provider = string(vc.Provider)
	}
	if identity != nil {
		vc.CloudAccountID = resolveAccountID(identity)
	}
	if vc.CloudAccountID == "" {
		vc.CloudAccountID = resolveAmbientAccountID(provider)
	}

	// A namespace/vcluster environment's cluster row names the SHARED Fabric cluster: minting it
	// would hand a tenant of one namespace the whole cluster. Refused here whatever the console did.
	if vc.PlacementMode == types.PlacementModeNamespace || vc.PlacementMode == types.PlacementModeVcluster {
		return none, nil, failMint(mintReasonSharedCluster, "placement", nil)
	}
	switch types.CloudProvider(provider) {
	case types.CloudProviderAws, types.CloudProviderGcp, types.CloudProviderAzure:
	case types.CloudProviderAlibaba, types.CloudProviderHetzner:
		// Certificates only (decision 4): no exec plugin can re-mint them. The console refuses this
		// too; the runner does not rely on it.
		if spec.Shape == types.KubeconfigMintShapeExec {
			return none, nil, failMint(mintReasonShape, "shape", nil)
		}
	case types.CloudProviderDigitalocean, types.CloudProviderCivo:
		return none, nil, failMint(mintReasonShape, "provider", nil)
	default:
		return none, nil, failMint(mintReasonShape, "provider", nil)
	}

	ttl := time.Duration(spec.TTLSeconds) * time.Second
	admin, failure := w.adminConnection(ctx, job, provider, vc, spec, seams, stdout, stderr)
	if failure != nil {
		return none, nil, failure
	}
	private := kubeaccess.ClassifyEndpoint(ctx, admin.server, seams.resolver).Reach.PrivateEndpoint()
	target := kubeaccess.Target{Project: vc.ProjectName, Env: mintEnvName(vc), Server: admin.server, CAData: admin.caData}

	cred := types.KubeconfigMintCredential{Shape: spec.Shape, Tier: spec.Tier}
	switch spec.Tier {
	case types.KubeconfigMintTierReadonly:
		tok, failure := mintReadOnly(ctx, admin, ttl, seams)
		if failure != nil {
			return none, private, failure
		}
		cred.ExpiresAt = tok.ExpiresAt
		if failure := fillCredential(&cred, target, kubeaccess.StaticCredential{Token: tok.Token}); failure != nil {
			return none, private, failure
		}
	case types.KubeconfigMintTierAdmin:
		// The cloud's own credential, with its REAL expiry — which may be shorter than the TTL (an EKS
		// token lives 14 minutes) or longer (a Talos admin certificate's lifetime is the cluster's
		// adminKubeconfig.certLifetime, which the Talos API does not let a caller shorten). Claiming a
		// shorter one than the credential really has would be a lie the user acts on.
		if admin.cert != nil {
			cred.ExpiresAt = admin.cert.NotAfter
			if failure := fillCredential(&cred, target, kubeaccess.StaticCredential{
				ClientCertData: admin.cert.ClientCertData, ClientKeyData: admin.cert.ClientKeyData,
			}); failure != nil {
				return none, private, failure
			}
		} else {
			cred.ExpiresAt = admin.tokenExpiry
			if failure := fillCredential(&cred, target, kubeaccess.StaticCredential{Token: admin.token}); failure != nil {
				return none, private, failure
			}
		}
	default:
		return none, private, failMint(mintReasonUnknown, "tier", nil)
	}
	if err := cred.Validate(); err != nil {
		return none, private, failMint(mintReasonUnknown, "validate credential", err)
	}
	return cred, private, nil
}

// mintEnvName is the env half of the context name: the environment stage the snapshot names.
func mintEnvName(vc *types.ProjectConfig) string {
	if vc.EnvironmentStage != "" {
		return string(vc.EnvironmentStage)
	}
	return "env"
}

// fillCredential puts a credential into cred in its shape: exec carries the server, CA and token for
// `alethia cluster token` to print as an ExecCredential; static carries a rendered kubeconfig.
func fillCredential(cred *types.KubeconfigMintCredential, target kubeaccess.Target, sc kubeaccess.StaticCredential) *mintFailure {
	if cred.Shape == types.KubeconfigMintShapeExec {
		if sc.Token == "" {
			// Only a bearer token can ride an exec credential; a certificate cloud never gets here
			// (mintCredential refuses exec for it first), so this is defence in depth.
			return failMint(mintReasonShape, "exec shape", nil)
		}
		cred.Server, cred.CertificateAuthorityData, cred.Token = target.Server, target.CAData, sc.Token
		return nil
	}
	rendered, err := kubeaccess.RenderStaticKubeconfig(target, sc)
	if err != nil {
		return failMint(mintReasonUnknown, "render kubeconfig", err)
	}
	cred.Kubeconfig = string(rendered)
	return nil
}

// sealMintCredential seals the credential's JSON to the client key, bound to the mint and cluster.
func sealMintCredential(spec types.RunnerKubeconfigMintSpec, cred types.KubeconfigMintCredential) (string, *mintFailure) {
	plaintext, err := json.Marshal(cred)
	if err != nil {
		return "", failMint(mintReasonSeal, "encode credential", err)
	}
	defer clear(plaintext)
	sealed, err := kubeaccess.Seal(spec.ClientPublicKey, spec.MintID, spec.ClusterID, plaintext)
	if err != nil {
		return "", failMint(mintReasonSeal, "seal", err)
	}
	return sealed, nil
}

// mintReadOnly runs the read-only tier through the admin connection: ensure the alethia-view identity,
// then a TokenRequest for exactly ttl. The admin connection is dialled only after the dial guard.
func mintReadOnly(ctx context.Context, admin adminConn, ttl time.Duration, seams mintSeams) (kubeaccess.MintedToken, *mintFailure) {
	var none kubeaccess.MintedToken
	if err := assertMintServerDialable(ctx, admin.server, seams.lookupIP); err != nil {
		return none, failMint(mintReasonUnreachable, "dial guard", err)
	}
	kube, err := seams.newKube(admin.kubeConn())
	if err != nil {
		return none, failMint(mintReasonUnknown, "kube client", err)
	}
	if err := kubeaccess.EnsureReadOnlyAccess(ctx, kube, kubeaccess.ReadOnlyOptions{}); err != nil {
		return none, failMint(kubeFailureReason(err), "ensure read-only identity", err)
	}
	tok, err := kubeaccess.MintReadOnlyToken(ctx, kube, kubeaccess.ReadOnlyOptions{}, ttl)
	if err != nil {
		return none, failMint(kubeFailureReason(err), "token request", err)
	}
	return tok, nil
}

// kubeFailureReason tells an API server that answered (and refused, or holds drift the tier will not
// bind to) from one that could not be reached at all.
func kubeFailureReason(err error) string {
	var apiErr *kubeaccess.APIError
	if errors.As(err, &apiErr) {
		return mintReasonReadOnly
	}
	var urlErr *url.Error
	var netErr net.Error
	if errors.As(err, &urlErr) || errors.As(err, &netErr) || errors.Is(err, context.DeadlineExceeded) {
		return mintReasonUnreachable
	}
	return mintReasonReadOnly
}

// assertMintServerDialable refuses to dial an API server that resolves to loopback, link-local
// (169.254.169.254, the cloud metadata address, is link-local) or unspecified — the same boundary
// talos_kubeconfig.go's assertSafeTalosEndpoints draws. The server comes from a cloud API or, on
// Hetzner, from a kubeconfig the cluster itself returned, which a BYO module can influence. Private
// RFC 1918 addresses are allowed: the runner is in-network on purpose (decision 8).
func assertMintServerDialable(ctx context.Context, server string, lookup func(context.Context, string) ([]netip.Addr, error)) error {
	u, err := url.Parse(server)
	if err != nil || u.Hostname() == "" {
		return errors.New("the API server is not a URL with a host")
	}
	host := u.Hostname()
	var addrs []netip.Addr
	if a, err := netip.ParseAddr(host); err == nil {
		addrs = []netip.Addr{a}
	} else {
		if addrs, err = lookup(ctx, host); err != nil || len(addrs) == 0 {
			return errors.New("the API server's host does not resolve")
		}
	}
	for _, a := range addrs {
		a = a.Unmap()
		if a.IsLoopback() || a.IsLinkLocalUnicast() || a.IsLinkLocalMulticast() || a.IsUnspecified() {
			return errors.New("the API server resolves to a loopback, link-local or unspecified address; refusing to dial it from the runner")
		}
	}
	return nil
}

// adminConnection gets the cluster's admin connection with the cloud's existing minter.
func (w *Runner) adminConnection(ctx context.Context, job *Job, provider string, vc *types.ProjectConfig, spec types.RunnerKubeconfigMintSpec, seams mintSeams, stdout, stderr *JobLogger) (adminConn, *mintFailure) {
	if types.CloudProvider(provider) == types.CloudProviderHetzner {
		return w.talosAdminConnection(ctx, job, seams)
	}
	name, failure := w.mintClusterName(ctx, job, vc, seams, stdout, stderr)
	if failure != nil {
		return adminConn{}, failure
	}
	fmt.Fprintf(stdout, "Resolving %s cluster %s…\n", provider, name)

	var (
		server, ca string
		token      string
		expiry     time.Time
		err        error
	)
	switch types.CloudProvider(provider) {
	case types.CloudProviderAws:
		if server, ca, err = seams.eksConn(ctx, vc.Region, name); err != nil {
			return adminConn{}, failMint(mintReasonNotFound, "eks describe", err)
		}
		token, expiry, err = seams.eksToken(ctx, name, vc.Region)
	case types.CloudProviderGcp:
		if server, ca, err = seams.gkeConn(ctx, vc, name); err != nil {
			return adminConn{}, failMint(mintReasonNotFound, "gke get", err)
		}
		token, expiry, err = seams.gkeToken(ctx)
	case types.CloudProviderAzure:
		if server, ca, err = seams.aksConn(ctx, vc, name); err != nil {
			return adminConn{}, failMint(mintReasonNotFound, "aks get", err)
		}
		token, expiry, err = seams.aksToken(ctx)
	case types.CloudProviderAlibaba:
		return ackAdminConnection(ctx, vc, name, spec, seams)
	case types.CloudProviderHetzner, types.CloudProviderDigitalocean, types.CloudProviderCivo:
		// Hetzner returned above; mintCredential refuses the other two before this is reached.
		return adminConn{}, failMint(mintReasonShape, "provider", nil)
	default:
		return adminConn{}, failMint(mintReasonShape, "provider", nil)
	}
	if err != nil {
		return adminConn{}, failMint(mintReasonIdentity, provider+" token", err)
	}
	if token == "" || expiry.IsZero() {
		return adminConn{}, failMint(mintReasonRefused, provider+" token", nil)
	}
	if server == "" || ca == "" {
		return adminConn{}, failMint(mintReasonNotFound, provider+" endpoint", nil)
	}
	if !strings.HasPrefix(server, "https://") {
		server = "https://" + server
	}
	return adminConn{server: server, caData: ca, token: token, tokenExpiry: expiry}, nil
}

// ackAdminConnection asks ACK for a user kubeconfig whose certificate lives exactly as long as the
// tier needs: TTL (rounded up to whole minutes) for admin, ACK's 15-minute floor for the read-only
// tier, which uses it only to create its identity.
func ackAdminConnection(ctx context.Context, vc *types.ProjectConfig, name string, spec types.RunnerKubeconfigMintSpec, seams mintSeams) (adminConn, *mintFailure) {
	minutes := ackReadOnlySetupMinutes
	if spec.Tier == types.KubeconfigMintTierAdmin {
		minutes = (spec.TTLSeconds + 59) / 60
	}
	raw, err := seams.ackKubeconfig(ctx, vc.Region, name, minutes)
	if err != nil {
		if errors.Is(err, cloud.ErrACKClusterNotReady) {
			return adminConn{}, failMint(mintReasonNotFound, "ack user kubeconfig", err)
		}
		return adminConn{}, failMint(mintReasonRefused, "ack user kubeconfig", err)
	}
	cert, err := parseCertKubeconfig(raw)
	if err != nil {
		return adminConn{}, failMint(mintReasonRefused, "parse ack kubeconfig", err)
	}
	return adminConn{server: cert.Server, caData: cert.CAData, cert: &cert}, nil
}

// talosAdminConnection mints a Talos admin kubeconfig from the Fabric's talosconfig, fetched over the
// runner-authenticated job channel the placement path already uses. Both stay in memory.
func (w *Runner) talosAdminConnection(ctx context.Context, job *Job, seams mintSeams) (adminConn, *mintFailure) {
	talosconfig, err := w.api.FetchFabricTalosconfig(job.ID)
	if err != nil {
		return adminConn{}, failMint(mintReasonIdentity, "fetch talosconfig", err)
	}
	if strings.TrimSpace(talosconfig) == "" {
		return adminConn{}, failMint(mintReasonIdentity, "fetch talosconfig", errors.New("the Fabric has no talosconfig"))
	}
	raw, err := seams.talosKubeconfig(ctx, talosconfig)
	if err != nil {
		return adminConn{}, failMint(mintReasonUnreachable, "talos kubeconfig", err)
	}
	defer clear(raw)
	cert, err := parseCertKubeconfig(string(raw))
	if err != nil {
		return adminConn{}, failMint(mintReasonRefused, "parse talos kubeconfig", err)
	}
	return adminConn{server: cert.Server, caData: cert.CAData, cert: &cert}, nil
}

// mintClusterName is the cloud's name for the cluster: the snapshot's when the deploy recorded it,
// else the environment's tofu outputs (a first deploy's snapshot predates the name), exactly the
// fallback drift and the liveness probe use.
func (w *Runner) mintClusterName(ctx context.Context, job *Job, vc *types.ProjectConfig, seams mintSeams, stdout, stderr *JobLogger) (string, *mintFailure) {
	if name := strings.TrimSpace(vc.Cluster.ClusterName); name != "" {
		return name, nil
	}
	outputs, err := seams.readOutputs(ctx, w, job, vc, stdout, stderr)
	if err != nil {
		return "", failMint(mintReasonNotFound, "read outputs", err)
	}
	if name := strings.TrimSpace(cloud.ExtractClusterName(outputs)); name != "" {
		return name, nil
	}
	return "", failMint(mintReasonNotFound, "cluster name", nil)
}
