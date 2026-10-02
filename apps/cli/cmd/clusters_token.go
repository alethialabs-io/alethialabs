// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"regexp"
	"time"

	"github.com/alethialabs-io/alethialabs/apps/cli/internal/kubecache"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/alethialabs-io/alethialabs/packages/core/kubeaccess"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
	"github.com/spf13/cobra"
)

// `alethia cluster token <cluster-id>` — the exec credential plugin an Alethia kubeconfig runs
// (#5284; the kubeconfig is kubeaccess.RenderExecKubeconfig, decision 4 of #5250).
//
// kubectl runs it on every call that has no live token, with interactiveMode Never, and reads one
// client.authentication.k8s.io/v1 ExecCredential from stdout. So:
//
//   - stdout carries that document and nothing else, ever. Every error goes to stderr with a
//     non-zero exit, which kubectl shows the user as the reason the call failed.
//   - it never prompts — not for a login (an expired session is an error naming `alethia login`),
//     not for a cluster. The picker below runs only for a person who omits the id at a terminal.
//   - it is fast when it can be: the credential is cached on disk (internal/kubecache) and served
//     while it has at least 60 seconds left, so the runner round-trip is paid once per TTL. The
//     cache is locked per cluster, so several kubectl processes starting at once on a cold cache
//     produce ONE mint: the first mints, the rest wait for the lock and find its entry.
//   - it re-mints with the tier, TTL and org the user chose with `alethia cluster kubeconfig`
//     (kubecache.Profile). A cluster with no profile — a kubeconfig copied from another machine —
//     gets the read-only tier, the lesser of the two, never the admin one.
//
// Every re-mint goes through the control plane, which re-checks the caller's permission, so a member
// removed from the org stops getting tokens within one TTL (#5250 §5).

// clusterTokenLockWait bounds the wait for another process's mint of the same cluster: a little
// longer than the longest a mint can take (kubeMintPollCeiling).
const clusterTokenLockWait = kubeMintPollCeiling + time.Minute

// canonicalClusterID is the shape the exec kubeconfig writes the cluster id in.
var canonicalClusterID = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

var clusterTokenCmd = &cobra.Command{
	Use:   "token [cluster-id]",
	Short: "Print a cluster credential for kubectl (the exec plugin an Alethia kubeconfig runs)",
	Long: `Print a client.authentication.k8s.io/v1 ExecCredential for one cluster on stdout.

This is the command the kubeconfig written by ` + "`alethia cluster kubeconfig`" + ` runs for kubectl; you
do not normally run it yourself. The credential is cached on disk until shortly before it expires,
so only the first kubectl call in each token's lifetime waits for a new one to be minted. It never
prompts: an expired session is an error telling you to run ` + "`alethia login`" + `.

Run it at a terminal without a cluster id and it asks which cluster, which is a way to check that
your session can still mint a credential.`,
	Args: cobra.MaximumNArgs(1),
	// kubectl reads this command's stdout as JSON: no update notice, on any stream, ever.
	Annotations: map[string]string{skipUpdateNoticeAnnotation: "true"},
	Run: func(cmd *cobra.Command, args []string) {
		if err := runClusterToken(args, os.Stdout); err != nil {
			fmt.Fprintln(os.Stderr, "alethia cluster token: "+err.Error())
			exitFunc(1)
		}
	},
}

// runClusterToken resolves the cluster, serves the cached credential or mints one, and writes the
// ExecCredential to out.
func runClusterToken(args []string, out io.Writer) error {
	clusterID, err := clusterTokenTarget(args)
	if err != nil {
		return err
	}
	cache, err := openKubeCache()
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), clusterTokenLockWait)
	defer cancel()
	unlock, err := cache.Lock(ctx, clusterID)
	if err != nil {
		return err
	}
	defer unlock()

	profile, ok, err := cache.Profile(clusterID)
	if err != nil {
		return err
	}
	if !ok {
		profile = kubecache.Profile{ClusterID: clusterID, Tier: types.KubeconfigMintTierReadonly, TTLSeconds: types.KubeconfigMintTTLDefaultSeconds}
	}
	entry, err := cache.Get(clusterID, profile.Tier)
	if err != nil {
		return err
	}
	if entry == nil || !entry.FreshAt(kubeNow()) {
		if entry, err = mintClusterToken(cache, profile); err != nil {
			return err
		}
	}
	doc, err := kubeaccess.RenderExecCredential(entry.Token, entry.ExpiresAt)
	if err == nil {
		_, err = out.Write(doc)
	}
	return err
}

// openKubeCache opens the credential cache in its default directory.
func openKubeCache() (*kubecache.Cache, error) {
	dir, err := kubecache.DefaultDir()
	if err != nil {
		return nil, err
	}
	return kubecache.Open(dir)
}

// clusterTokenTarget is the cluster id: the argument, which must be canonical, or — for a person at
// a terminal who omitted it — the picker. Without a terminal an absent id is an error, never a
// prompt, because kubectl cannot answer one.
func clusterTokenTarget(args []string) (string, error) {
	if len(args) == 1 {
		if !canonicalClusterID.MatchString(args[0]) {
			return "", fmt.Errorf("%q is not a cluster id (a lowercase uuid, as `alethia cluster get` shows it)", args[0])
		}
		return args[0], nil
	}
	if err := requireInteractiveForm(); err != nil {
		return "", errors.New("a cluster id is required (kubectl passes it; at a terminal, omit it to pick one)")
	}
	token, err := getAuthTokenInternal(false)
	if err != nil {
		return "", err
	}
	clusters, err := api.NewClient(token).GetClusters()
	if err != nil {
		return "", fmt.Errorf("failed to fetch clusters: %w", err)
	}
	c, err := resolveCluster(clusters, "")
	if err != nil {
		return "", err
	}
	return c.ID, nil
}

// mintClusterToken mints an exec credential with the cluster's profile and caches it. It never
// prompts for a login: kubectl has no way to answer one.
func mintClusterToken(cache *kubecache.Cache, profile kubecache.Profile) (*kubecache.Entry, error) {
	// The org the kubeconfig was minted in, unless --org names one for this call: the active org
	// may have changed since, and the cluster is not in that one.
	if profile.OrgID != "" && api.OrgOverride() == "" {
		api.SetOrgOverride(profile.OrgID)
	}
	token, err := getAuthTokenInternal(false)
	if err != nil {
		return nil, err
	}
	spec := kubeMintSpec{ClusterID: profile.ClusterID, Tier: profile.Tier, Shape: types.KubeconfigMintShapeExec, TTLSeconds: profile.TTLSeconds}
	minted, err := mintKubeCredential(api.NewClient(token), spec)
	if err != nil {
		return nil, kubeMintRefusal(err, spec.Tier)
	}
	entry := kubecache.Entry{ClusterID: profile.ClusterID, Tier: profile.Tier, Token: minted.Cred.Token, ExpiresAt: minted.Cred.ExpiresAt}
	if err := cache.Put(entry); err != nil {
		// The credential is good; only the next call's shortcut is lost. Say so on stderr and serve.
		fmt.Fprintf(os.Stderr, "alethia cluster token: could not cache the credential (%v); the next call will mint again\n", err)
	}
	return &entry, nil
}

func init() {
	clusterCmd.AddCommand(clusterTokenCmd)
}
