// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"errors"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
	"github.com/spf13/cobra"
	"github.com/spf13/pflag"
)

// Dynamic shell completion: the names of the caller's projects, environments, runners, clusters and
// organizations, offered by `alethia __complete` — the hidden command every cobra completion script
// calls when the user presses TAB.
//
// Three properties hold for every completion here, because a shell is the reader:
//
//   - It never prompts and never signs in. A credential is used only when one is already usable as
//     it stands: --token / ALETHIA_TOKEN, or a stored sign-in that has not expired. An expired one is
//     not renewed — renewal writes to the keychain and prints a line, neither of which belongs inside
//     a TAB press.
//   - It is bounded. Each completion waits at most completionTimeout for the control plane, however
//     long the client's own timeout and read retries would have let the request run.
//   - It fails silent. A missing credential, a refused request, a timeout or a panic all produce the
//     same answer: no candidates, and no file-name fallback. Nothing is written to stdout but the
//     completion protocol cobra prints, and nothing of ours to stderr.
//
// Registration happens from this one file, by walking the command tree once it is complete. Go runs
// this file's init before the files that add most commands (it sorts first), so the walk is deferred
// to cobra.OnInitialize, which runs inside Execute — after every init in the package, and before
// `__complete` asks any command for its candidates.

// completionTimeout bounds one completion's whole round trip to the control plane, credential read
// included. Short on purpose: a TAB press that takes longer than this is worse than one that offers
// nothing.
var completionTimeout = 2 * time.Second

// completionLister is the slice of the API client the completions read. *api.Client satisfies it,
// and so does the package's test fake.
type completionLister interface {
	ListOrgs() ([]api.OrgSummary, error)
	GetRunners() ([]api.Runner, error)
	GetClusters() ([]api.ClusterSummary, error)
	GetConfigurations() ([]types.ConfigurationSummary, error)
	ListEnvironments(project string) ([]api.Environment, error)
}

// completionClientFor builds the client a completion reads through. A variable so a test can hand
// the completions a fake control plane.
var completionClientFor = func(token string) completionLister { return api.NewClient(token) }

// completionCredential returns a credential that is usable without asking, renewing or writing
// anything, or false when there is none. A variable so a test can decide whether the caller is
// signed in.
var completionCredential = func() (string, bool) {
	if t := serviceToken(); t != "" {
		return t, true
	}
	cred, _, err := loadStoredCredential()
	if err != nil {
		return "", false
	}
	expires, ok := tokenExpiry(cred.AccessToken)
	if !ok || !expires.After(time.Now().Add(tokenRenewalMargin)) {
		return "", false
	}
	return cred.AccessToken, true
}

// errCompletionPanicked stands in for a fetch that panicked, so it is answered like any failure.
var errCompletionPanicked = errors.New("completion fetch panicked")

// completionFetch runs one read against the control plane for a completion and returns its result,
// or false on any failure: no credential, an error, a panic, or no answer within completionTimeout.
//
// The read runs on its own goroutine so the deadline holds even when the request itself would not
// return for much longer. A read abandoned at the deadline is left to finish on its own; the
// process exits as soon as the completion is printed.
func completionFetch[T any](read func(completionLister) (T, error)) (T, bool) {
	type answer struct {
		value T
		err   error
	}
	// The token refresher stays unset: a 401 here ends the completion instead of renewing a
	// credential, which would write to the keychain and print a line.
	api.SetTokenRefresher(nil)
	// --org was parsed after the root's pre-run had already applied it (the completion command
	// parses no flags of its own), so it is applied again here, where its value is known.
	applyOrgScope()
	// Read once, here: a read abandoned at the deadline must not touch the package's variables
	// after this function has returned.
	credential, clientFor := completionCredential, completionClientFor
	done := make(chan answer, 1)
	go func() {
		defer func() {
			if recover() != nil {
				done <- answer{err: errCompletionPanicked}
			}
		}()
		// Inside the deadline too: a keychain read is a call into the OS that is not ours to bound.
		token, ok := credential()
		if !ok {
			done <- answer{err: errNotSignedIn}
			return
		}
		v, err := read(clientFor(token))
		done <- answer{value: v, err: err}
	}()
	var zero T
	select {
	case a := <-done:
		if a.err != nil {
			return zero, false
		}
		return a.value, true
	case <-time.After(completionTimeout):
		return zero, false
	}
}

// completionCandidate is one value a shell may offer, with the short description shown beside it.
type completionCandidate struct {
	value string
	desc  string
}

// completionAnswer turns candidates into what cobra prints: the ones that start with what the user
// has typed, de-duplicated and sorted, each with its description. File names are never offered —
// a resource name is never a path, and on a failure an empty list must stay empty.
func completionAnswer(candidates []completionCandidate, toComplete string) ([]cobra.Completion, cobra.ShellCompDirective) {
	seen := map[string]bool{}
	var out []cobra.Completion
	for _, c := range candidates {
		if c.value == "" || seen[c.value] || !strings.HasPrefix(c.value, toComplete) {
			continue
		}
		seen[c.value] = true
		out = append(out, cobra.CompletionWithDesc(c.value, c.desc))
	}
	sort.Strings(out)
	return out, cobra.ShellCompDirectiveNoFileComp
}

// joinDesc joins the non-empty parts of a description with a middle dot.
func joinDesc(parts ...string) string {
	kept := parts[:0]
	for _, p := range parts {
		if p != "" {
			kept = append(kept, p)
		}
	}
	return strings.Join(kept, " · ")
}

// completeProjects offers the caller's project names. The configurations endpoint returns one row
// per project and environment, so a project with three environments is offered once, described by
// its first row.
func completeProjects() []completionCandidate {
	configs, _ := completionFetch(func(c completionLister) ([]types.ConfigurationSummary, error) {
		return c.GetConfigurations()
	})
	out := make([]completionCandidate, 0, len(configs))
	for _, p := range configs {
		out = append(out, completionCandidate{p.ProjectName, joinDesc(string(p.CloudProvider), p.Region)})
	}
	return out
}

// completeEnvironments offers the environment names of one project, described by stage and status.
// With no project known there is nothing to list, so nothing is offered.
func completeEnvironments(project string) []completionCandidate {
	if project == "" {
		return nil
	}
	envs, _ := completionFetch(func(c completionLister) ([]api.Environment, error) {
		return c.ListEnvironments(project)
	})
	out := make([]completionCandidate, 0, len(envs))
	for _, e := range envs {
		out = append(out, completionCandidate{e.Name, joinDesc(e.Stage, e.Status)})
	}
	return out
}

// listRunners reads the caller's runners for a completion.
func listRunners() []api.Runner {
	runners, _ := completionFetch(func(c completionLister) ([]api.Runner, error) { return c.GetRunners() })
	return runners
}

// completeRunnerNames offers runner names, for a flag that takes the name or the id.
func completeRunnerNames() []completionCandidate {
	runners := listRunners()
	out := make([]completionCandidate, 0, len(runners))
	for _, r := range runners {
		out = append(out, completionCandidate{r.Name, joinDesc(r.Status, runnerOperatorLabel(r))})
	}
	return out
}

// completeRunnerIDs offers runner ids described by name, for an argument that takes only the id.
func completeRunnerIDs() []completionCandidate {
	runners := listRunners()
	out := make([]completionCandidate, 0, len(runners))
	for _, r := range runners {
		out = append(out, completionCandidate{r.ID, joinDesc(r.Name, r.Status)})
	}
	return out
}

// listClusters reads the caller's clusters for a completion.
func listClusters() []api.ClusterSummary {
	clusters, _ := completionFetch(func(c completionLister) ([]api.ClusterSummary, error) { return c.GetClusters() })
	return clusters
}

// clusterCompletionDesc describes a cluster by the project and environment it serves and its status.
func clusterCompletionDesc(c api.ClusterSummary) string {
	return joinDesc(c.ProjectName, c.Environment, c.Status)
}

// completeClusterSelectors offers, per cluster, the selector `cluster get` and `cluster kubeconfig`
// take: its name, or its id when it has none (clusterSelector, the value the commands' own error
// messages tell a user to re-run with).
func completeClusterSelectors() []completionCandidate {
	clusters := listClusters()
	out := make([]completionCandidate, 0, len(clusters))
	for _, c := range clusters {
		out = append(out, completionCandidate{clusterSelector(c), clusterCompletionDesc(c)})
	}
	return out
}

// completeClusterIDs offers cluster ids described by name, for an argument that takes only the id.
func completeClusterIDs() []completionCandidate {
	clusters := listClusters()
	out := make([]completionCandidate, 0, len(clusters))
	for _, c := range clusters {
		out = append(out, completionCandidate{c.ID, joinDesc(c.ClusterName, clusterCompletionDesc(c))})
	}
	return out
}

// listOrgs reads the caller's organizations for a completion.
func listOrgs() []api.OrgSummary {
	orgs, _ := completionFetch(func(c completionLister) ([]api.OrgSummary, error) { return c.ListOrgs() })
	return orgs
}

// completeOrgIDs offers organization ids described by name and role, for --org, which takes the id.
func completeOrgIDs() []completionCandidate {
	orgs := listOrgs()
	out := make([]completionCandidate, 0, len(orgs))
	for _, o := range orgs {
		out = append(out, completionCandidate{o.ID, joinDesc(o.Name, o.Role)})
	}
	return out
}

// completeOrgSlugs offers organization slugs (the id when an org has none) described by name, for
// `org switch`, which takes an id, slug or name and reads best with the slug.
func completeOrgSlugs() []completionCandidate {
	orgs := listOrgs()
	out := make([]completionCandidate, 0, len(orgs))
	for _, o := range orgs {
		v := o.Slug
		if v == "" {
			v = o.ID
		}
		out = append(out, completionCandidate{v, joinDesc(o.Name, o.Role)})
	}
	return out
}

// positionalCompletions maps a command path to what its FIRST positional argument names. Only the
// arguments that name an existing resource are here: `project create [name]` takes a new name, and
// offering the existing ones would suggest the one value certain to be refused.
var positionalCompletions = map[string]func() []completionCandidate{
	"alethia project get":        completeProjects,
	"alethia export":             completeProjects,
	"alethia config export":      completeProjects,
	"alethia cluster get":        completeClusterSelectors,
	"alethia cluster kubeconfig": completeClusterSelectors,
	"alethia cluster token":      completeClusterIDs,
	"alethia runner remove":      completeRunnerIDs,
	"alethia org switch":         completeOrgSlugs,
}

// projectPositional reports whether a command's first positional argument is a project, so a
// --env on that command lists that project's environments.
func projectPositional(cmd *cobra.Command) bool {
	switch cmd.CommandPath() {
	case "alethia export", "alethia config export":
		return true
	}
	return false
}

// foreignProjectFlags lists the commands whose --project names something other than an Alethia
// project — `connector gcp --project` is a GCP project id — so it is not completed with ours.
var foreignProjectFlags = map[string]bool{
	"alethia connector gcp": true,
}

// projectForEnv returns the project an --env completion lists environments for: the command's
// --project when given, else its project argument when it takes one.
func projectForEnv(cmd *cobra.Command, args []string) string {
	if f := cmd.Flags().Lookup("project"); f != nil && f.Value.String() != "" {
		return f.Value.String()
	}
	if projectPositional(cmd) && len(args) > 0 {
		return args[0]
	}
	return ""
}

// flagCompletion returns the completion for one flag a command defines, or nil when the flag names
// nothing these completions know how to list.
func flagCompletion(cmd *cobra.Command, f *pflag.Flag) cobra.CompletionFunc {
	switch f.Name {
	case "project":
		if foreignProjectFlags[cmd.CommandPath()] {
			return nil
		}
		return func(_ *cobra.Command, _ []string, toComplete string) ([]cobra.Completion, cobra.ShellCompDirective) {
			return completionAnswer(completeProjects(), toComplete)
		}
	case "env":
		return func(c *cobra.Command, args []string, toComplete string) ([]cobra.Completion, cobra.ShellCompDirective) {
			return completionAnswer(completeEnvironments(projectForEnv(c, args)), toComplete)
		}
	case "runner":
		return func(_ *cobra.Command, _ []string, toComplete string) ([]cobra.Completion, cobra.ShellCompDirective) {
			return completionAnswer(completeRunnerNames(), toComplete)
		}
	case "cluster":
		return func(_ *cobra.Command, _ []string, toComplete string) ([]cobra.Completion, cobra.ShellCompDirective) {
			return completionAnswer(completeClusterSelectors(), toComplete)
		}
	case "org":
		return func(_ *cobra.Command, _ []string, toComplete string) ([]cobra.Completion, cobra.ShellCompDirective) {
			return completionAnswer(completeOrgIDs(), toComplete)
		}
	}
	return nil
}

// positionalCompletion returns the ValidArgsFunction for a command in positionalCompletions: the
// first argument is completed, and nothing after it.
func positionalCompletion(list func() []completionCandidate) cobra.CompletionFunc {
	return func(_ *cobra.Command, args []string, toComplete string) ([]cobra.Completion, cobra.ShellCompDirective) {
		if len(args) > 0 {
			return nil, cobra.ShellCompDirectiveNoFileComp
		}
		return completionAnswer(list(), toComplete)
	}
}

// attachDynamicCompletions walks the tree under root and registers every completion above. A
// command or flag that already carries its own completion keeps it.
func attachDynamicCompletions(root *cobra.Command) {
	var walk func(cmd *cobra.Command)
	walk = func(cmd *cobra.Command) {
		if list, ok := positionalCompletions[cmd.CommandPath()]; ok && cmd.ValidArgsFunction == nil && len(cmd.ValidArgs) == 0 {
			cmd.ValidArgsFunction = positionalCompletion(list)
		}
		// The flags this command DEFINES — its own and the persistent ones it hands down. A
		// completion is keyed by the flag itself, so registering an inherited flag once, where it
		// is defined, covers every command beneath.
		register := func(f *pflag.Flag) {
			if fn := flagCompletion(cmd, f); fn != nil {
				// An error means the flag already has a completion, which it keeps.
				_ = cmd.RegisterFlagCompletionFunc(f.Name, fn)
			}
		}
		cmd.LocalNonPersistentFlags().VisitAll(register)
		cmd.PersistentFlags().VisitAll(register)
		for _, child := range cmd.Commands() {
			walk(child)
		}
	}
	walk(root)
}

// markCompletionCommandsQuiet keeps the upgrade notice off cobra's completion commands: what they
// print is read by a shell script, not a person.
func markCompletionCommandsQuiet(root *cobra.Command) {
	for _, c := range root.Commands() {
		if c.Name() != cobra.ShellCompRequestCmd {
			continue
		}
		if c.Annotations == nil {
			c.Annotations = map[string]string{}
		}
		c.Annotations[skipUpdateNoticeAnnotation] = "true"
	}
}

// dynamicCompletionsOnce makes the tree walk happen once per process, however many commands run.
var dynamicCompletionsOnce sync.Once

// registerDynamicCompletions is the cobra initializer that attaches the completions to rootCmd.
func registerDynamicCompletions() {
	dynamicCompletionsOnce.Do(func() { attachDynamicCompletions(rootCmd) })
	markCompletionCommandsQuiet(rootCmd)
}

// init defers the tree walk to cobra's initializers, which run once every command has been added.
func init() {
	cobra.OnInitialize(registerDynamicCompletions)
}
