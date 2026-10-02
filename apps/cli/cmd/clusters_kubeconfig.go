// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"time"

	"github.com/alethialabs-io/alethialabs/apps/cli/internal/kubecache"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/alethialabs-io/alethialabs/packages/core/format"
	"github.com/alethialabs-io/alethialabs/packages/core/kubeaccess"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
	"github.com/spf13/cobra"
)

// `alethia cluster kubeconfig` — a short-lived kubeconfig minted by the control plane (#5284).
//
// ── THE FIELD SPEC ─────────────────────────────────────────────────────────────────────────────
//
// It takes the cluster (the same selector and picker as `cluster get`: resolveCluster) and five
// flags, every one of which has a default, so `--no-input` with a selector is a complete call:
//
//	--admin    the admin tier instead of read-only (needs cluster:access_admin)
//	--ttl      the credential lifetime, 15m to 8h (default 1h)
//	--static   a self-contained file instead of the exec shape (always static on Hetzner/Alibaba)
//	--merge    merge into $KUBECONFIG or ~/.kube/config (the default)
//	--output   write a standalone file instead; `-` is stdout, the ONLY way the credential is printed
//
// Where everything goes: the kubeconfig to the file (or stdout under `--output -`); every word
// meant for a person to stderr. So stdout is empty unless `--output -` asked for the document.
//
// `--output` here is a FILE, not the global table/json/csv format: this command renders no table,
// and the flag reads the way kubectl's tools spell it. A format name passed by habit is refused
// rather than written to a file called `json`.

// kubeStatusOut is where the command's progress and summary lines go: stderr, so stdout carries
// nothing but a document that was asked for.
var kubeStatusOut io.Writer = os.Stderr

// kubeconfigOpts is the parsed flag set.
type kubeconfigOpts struct {
	Admin  bool
	TTL    time.Duration
	Static bool
	Output string
}

// errKubeconfigOutputFormat refuses `--output json` and friends: the habit from every other command
// would otherwise write a credential to a file named `json`.
var errKubeconfigOutputFormat = errors.New("--output takes a file path here (or - for stdout), not a format; to write a file with that name, pass ./ in front of it")

// tier returns the mint tier the flags ask for.
func (o kubeconfigOpts) tier() types.KubeconfigMintTier {
	if o.Admin {
		return types.KubeconfigMintTierAdmin
	}
	return types.KubeconfigMintTierReadonly
}

// ttlSeconds validates --ttl against the mint bounds and returns it in whole seconds.
func (o kubeconfigOpts) ttlSeconds() (int, error) {
	if o.TTL%time.Second != 0 || types.ValidateKubeconfigMintTTL(int(o.TTL/time.Second)) != nil {
		return 0, fmt.Errorf("--ttl must be whole seconds from 15m to 8h (got %s)", o.TTL)
	}
	return int(o.TTL / time.Second), nil
}

var clusterKubeconfigCmd = &cobra.Command{
	Use:   "kubeconfig [selector]",
	Short: "Get a short-lived kubeconfig for a cluster, minted through Alethia",
	Long: `Mint a short-lived kubeconfig for a cluster and add it to your kubeconfig, without any
cloud login of your own. A runner in the cluster's network mints the credential and seals it to a
one-time key this command generates, so only this machine can open it.

The default is read-only access for 1h. --admin asks for the admin tier (owners and admins only).
On AWS, GCP and Azure the kubeconfig runs ` + "`alethia cluster token`" + ` as an exec plugin, so kubectl
gets a fresh token whenever one expires; --static writes a self-contained file instead. Hetzner and
Alibaba issue certificates, so their kubeconfig is always static and ends at its TTL.

By default the context alethia-<project>-<env> is merged into $KUBECONFIG (or ~/.kube/config) and
made current, leaving every other entry untouched. --output FILE writes a standalone file instead,
and --output - prints it: the only way the credential reaches stdout.

The selector matches by project name, cluster name, or id. Omit it at a terminal and the CLI asks
which cluster; pass it (or --no-input) and nothing is asked.`,
	Args: cobra.MaximumNArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		if err := runClusterKubeconfig(cmd, args); err != nil {
			fmt.Fprintln(kubeStatusOut, "Error: "+err.Error())
			exitFunc(1)
		}
	},
}

// kubeconfigOptsFrom reads and checks the flags before anything touches the network.
func kubeconfigOptsFrom(cmd *cobra.Command) (kubeconfigOpts, error) {
	var o kubeconfigOpts
	o.Admin, _ = cmd.Flags().GetBool("admin")
	o.TTL, _ = cmd.Flags().GetDuration("ttl")
	o.Static, _ = cmd.Flags().GetBool("static")
	o.Output, _ = cmd.Flags().GetString("output")
	if merge, _ := cmd.Flags().GetBool("merge"); !merge && o.Output == "" {
		return o, errors.New("--merge=false needs somewhere else to write: pass --output FILE (or - for stdout)")
	}
	if _, err := o.ttlSeconds(); err != nil {
		return o, err
	}
	switch o.Output {
	case "table", "json", "csv":
		return o, errKubeconfigOutputFormat
	}
	return o, nil
}

// kubeQuietly runs fn behind a spinner only when a person is watching: at a terminal with prompts
// enabled. Under --no-input (a script, CI) nothing is drawn at all.
func kubeQuietly(title string, fn func()) {
	if canPromptForm() {
		runSpinner(title, fn)
		return
	}
	fn()
}

// runClusterKubeconfig is the command: resolve the cluster, mint, render, write, report.
func runClusterKubeconfig(cmd *cobra.Command, args []string) error {
	opts, err := kubeconfigOptsFrom(cmd)
	if err != nil {
		return err
	}
	ttl, _ := opts.ttlSeconds()
	var query string
	if len(args) == 1 {
		query = args[0]
	}

	token, err := getAuthToken()
	if err != nil {
		return err
	}
	client := api.NewClient(token)
	var clusters []api.ClusterSummary
	kubeQuietly("Fetching clusters...", func() { clusters, err = client.GetClusters() })
	if err != nil {
		return fmt.Errorf("failed to fetch clusters: %w", err)
	}
	cluster, err := resolveCluster(clusters, query)
	if err != nil {
		return err
	}
	target := kubeaccess.Target{Project: cluster.ProjectName, Env: cluster.Environment}
	name, err := target.ContextName()
	if err != nil {
		return err
	}

	spec := kubeMintSpec{ClusterID: cluster.ID, Tier: opts.tier(), Shape: types.KubeconfigMintShapeExec, TTLSeconds: ttl}
	if opts.Static {
		spec.Shape = types.KubeconfigMintShapeStatic
	}
	var minted *kubeMinted
	title := "Minting a " + kubeTierLabel(spec.Tier) + " kubeconfig for " + clusterLabel(*cluster) + "..."
	kubeQuietly(title, func() { minted, err = mintKubeCredential(client, spec) })
	// The exec shape is the default, and the cloud decides whether it can have one: Hetzner and
	// Alibaba issue certificates and refuse it with a 422. The CLI does not know the cloud (the
	// cluster list does not carry it), so it asks for exec and falls back to static on that answer.
	// A second 422 is the cloud refusing both, and is reported as such.
	if err != nil && !opts.Static && kubeMintStatus(err) == http.StatusUnprocessableEntity {
		spec.Shape = types.KubeconfigMintShapeStatic
		kubeQuietly(title, func() { minted, err = mintKubeCredential(client, spec) })
	}
	if err != nil {
		return kubeMintRefusal(err, spec.Tier)
	}

	doc, err := renderMintedKubeconfig(minted, target, cluster.ID, name)
	if err != nil {
		return err
	}
	if spec.Shape == types.KubeconfigMintShapeExec {
		seedKubeCache(cluster.ID, spec, minted.Cred)
	}

	where, err := writeMintedKubeconfig(opts.Output, doc, name)
	if err != nil {
		return err
	}
	reportKubeconfig(where, name, spec, minted)
	return nil
}

// kubeTierLabel is the tier as a person reads it.
func kubeTierLabel(tier types.KubeconfigMintTier) string {
	if tier == types.KubeconfigMintTierAdmin {
		return "admin"
	}
	return "read-only"
}

// renderMintedKubeconfig turns an opened credential into the kubeconfig document: the exec shape
// rendered around the endpoint and CA the runner returned, or the runner's static file renamed to
// the context name.
func renderMintedKubeconfig(m *kubeMinted, target kubeaccess.Target, clusterID, name string) ([]byte, error) {
	if m.Cred.Shape == types.KubeconfigMintShapeStatic {
		return renameKubeconfig([]byte(m.Cred.Kubeconfig), name)
	}
	target.Server = m.Cred.Server
	target.CAData = m.Cred.CertificateAuthorityData
	return kubeaccess.RenderExecKubeconfig(target, clusterID, "")
}

// seedKubeCache stores the credential just minted, and the profile the exec plugin re-mints with,
// so the first kubectl call is served from the cache instead of paying a second round-trip. A
// failure here costs only that: it is reported and the kubeconfig is still written.
func seedKubeCache(clusterID string, spec kubeMintSpec, cred types.KubeconfigMintCredential) {
	orgID, _ := currentOrgID()
	err := func() error {
		cache, err := openKubeCache()
		if err != nil {
			return err
		}
		if err := cache.SetProfile(kubecache.Profile{ClusterID: clusterID, Tier: spec.Tier, TTLSeconds: spec.TTLSeconds, OrgID: orgID}); err != nil {
			return err
		}
		return cache.Put(kubecache.Entry{ClusterID: clusterID, Tier: spec.Tier, Token: cred.Token, ExpiresAt: cred.ExpiresAt})
	}()
	if err != nil {
		fmt.Fprintf(kubeStatusOut, "Warning: could not cache the credential (%v); the first kubectl call will mint a new one.\n", err)
	}
}

// writeMintedKubeconfig puts the document where the flags say and returns where that was, for the
// summary: "" for stdout.
func writeMintedKubeconfig(output string, doc []byte, name string) (string, error) {
	switch output {
	case "-":
		_, err := os.Stdout.Write(doc)
		return "", err
	case "":
		path, err := kubeconfigMergePath()
		if err != nil {
			return "", err
		}
		return path, mergeIntoKubeconfig(path, doc, name)
	default:
		return output, writeKubeconfigFile(output, doc)
	}
}

// reportKubeconfig tells the person what happened, on stderr.
func reportKubeconfig(where, name string, spec kubeMintSpec, m *kubeMinted) {
	out := kubeStatusOut
	switch {
	case where == "":
		// The document is on stdout; anything more here would only be noise in a pipe's terminal.
	case spec.Shape == types.KubeconfigMintShapeExec:
		fmt.Fprintf(out, "Wrote context %s to %s (current context).\n", name, where)
	default:
		fmt.Fprintf(out, "Wrote context %s to %s (current context, mode 0600).\n", name, where)
	}
	if spec.Shape == types.KubeconfigMintShapeExec {
		fmt.Fprintf(out, "Access: %s. kubectl gets each token from `alethia cluster token`, which mints a new one (up to %s) when the last expires.\n",
			kubeTierLabel(spec.Tier), format.Duration(time.Duration(spec.TTLSeconds)*time.Second))
	} else {
		fmt.Fprintf(out, "Access: %s, until %s. The file stops working then; run this command again for a new one.\n",
			kubeTierLabel(spec.Tier), format.Date(m.Cred.ExpiresAt, format.DateTime, time.Local))
	}
	if where != "" {
		fmt.Fprintf(out, "Try: kubectl --context %s get namespaces\n", name)
	}
	if m.PrivateEndpoint {
		fmt.Fprintln(out, "Note: this cluster's API endpoint is private. kubectl needs network access to it from this machine (a VPN or a bastion); the credential alone is not enough.")
	}
}

func init() {
	f := clusterKubeconfigCmd.Flags()
	f.Bool("admin", false, "Mint the admin tier instead of read-only (owners and admins only)")
	f.Duration("ttl", time.Duration(types.KubeconfigMintTTLDefaultSeconds)*time.Second, "Credential lifetime, 15m to 8h")
	f.Bool("static", false, "Write a self-contained kubeconfig that ends at its TTL, instead of the exec plugin")
	f.Bool("merge", true, "Merge into $KUBECONFIG or ~/.kube/config and make the context current")
	f.String("output", "", "Write a standalone kubeconfig to this FILE instead of merging (- for stdout)")
	clusterKubeconfigCmd.MarkFlagsMutuallyExclusive("merge", "output")
	clusterCmd.AddCommand(clusterKubeconfigCmd)
}
