// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/alethialabs-io/alethialabs/apps/cli/internal/kubecache"
	"gopkg.in/yaml.v3"
)

// Writing a minted kubeconfig: the standalone file, and the merge into the user's own kubeconfig.
//
// The merge is done on the YAML node tree, not on a decoded struct, so everything this command does
// not own survives byte-for-meaning: other clusters, users and contexts, unknown keys,
// `preferences`, extensions, and comments. What it owns is exactly three entries — the cluster, the
// user and the context named `alethia-<project>-<env>` — which it replaces when present and appends
// when not, and `current-context`, which it points at the new context the way `aws eks
// update-kubeconfig` and `gcloud container clusters get-credentials` do.
//
// Every write is atomic (kubecache.WritePrivateFile: a temp file in the same directory, synced,
// renamed over the target) and lands at mode 0600, because a static kubeconfig is a bearer
// credential. The merge also takes client-go's own lock file (`<path>.lock`, created exclusively),
// so it cannot interleave with a kubectl that is writing the same file.

// kubeconfigSections are the named lists a kubeconfig carries, each of which gets one entry.
var kubeconfigSections = []string{"clusters", "users", "contexts"}

// How long a merge waits for another writer's `<path>.lock`: tries × retry, five seconds.
const (
	kubeconfigLockTries = 50
	kubeconfigLockRetry = 100 * time.Millisecond
)

// kubeconfigMergePath is where --merge writes: the first path in $KUBECONFIG, which is the file
// kubectl itself writes new entries to, or ~/.kube/config.
func kubeconfigMergePath() (string, error) {
	for _, p := range filepath.SplitList(os.Getenv("KUBECONFIG")) {
		if strings.TrimSpace(p) != "" {
			return p, nil
		}
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("locate your home directory for ~/.kube/config: %w (pass --output FILE)", err)
	}
	return filepath.Join(home, ".kube", "config"), nil
}

// parseKubeconfigMapping parses a kubeconfig document and returns its top-level mapping node.
func parseKubeconfigMapping(doc []byte, what string) (*yaml.Node, *yaml.Node, error) {
	var root yaml.Node
	// The parser's error is not wrapped: it can quote the line it failed on, and in a static
	// kubeconfig that line can be the credential.
	if yaml.Unmarshal(doc, &root) != nil {
		return nil, nil, fmt.Errorf("%s is not valid YAML", what)
	}
	// An empty or comment-only document has no top-level node: it is an empty kubeconfig.
	if root.Kind == 0 || (root.Kind == yaml.DocumentNode && len(root.Content) == 0) {
		root = yaml.Node{Kind: yaml.DocumentNode, Content: []*yaml.Node{{Kind: yaml.MappingNode, Tag: "!!map"}}}
	}
	if root.Kind != yaml.DocumentNode || len(root.Content) != 1 || root.Content[0].Kind != yaml.MappingNode {
		return nil, nil, fmt.Errorf("%s is not a kubeconfig (its top level is not a mapping)", what)
	}
	return &root, root.Content[0], nil
}

// mappingValue returns the value node under key in a mapping, or nil.
func mappingValue(m *yaml.Node, key string) *yaml.Node {
	for i := 0; i+1 < len(m.Content); i += 2 {
		if m.Content[i].Value == key {
			return m.Content[i+1]
		}
	}
	return nil
}

// setMappingScalar sets key to a string scalar in a mapping, adding the key when it is absent.
func setMappingScalar(m *yaml.Node, key, value string) {
	if v := mappingValue(m, key); v != nil {
		*v = yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: value}
		return
	}
	m.Content = append(m.Content,
		&yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: key},
		&yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: value})
}

// sectionList returns the sequence under a section key, creating it when the key is absent or
// null, and refusing a section that is some other shape.
func sectionList(m *yaml.Node, key, what string) (*yaml.Node, error) {
	v := mappingValue(m, key)
	if v == nil {
		v = &yaml.Node{Kind: yaml.SequenceNode, Tag: "!!seq"}
		m.Content = append(m.Content, &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: key}, v)
		return v, nil
	}
	if v.Kind == yaml.ScalarNode && v.Tag == "!!null" {
		*v = yaml.Node{Kind: yaml.SequenceNode, Tag: "!!seq"}
	}
	if v.Kind != yaml.SequenceNode {
		return nil, fmt.Errorf("%s has a %q that is not a list", what, key)
	}
	return v, nil
}

// renameKubeconfig rewrites a single-cluster kubeconfig so its cluster, user and context are all
// called name, the context points at that cluster and user, and it is the current context. A
// static kubeconfig is rendered by the runner, which does not know the project and environment
// names; this files it under the same name the exec shape uses.
func renameKubeconfig(doc []byte, name string) ([]byte, error) {
	root, m, err := parseKubeconfigMapping(doc, "the minted kubeconfig")
	if err != nil {
		return nil, err
	}
	for _, section := range kubeconfigSections {
		list := mappingValue(m, section)
		if list == nil || list.Kind != yaml.SequenceNode || len(list.Content) != 1 || list.Content[0].Kind != yaml.MappingNode {
			return nil, fmt.Errorf("the minted kubeconfig does not carry exactly one entry under %q", section)
		}
		setMappingScalar(list.Content[0], "name", name)
	}
	ctx := mappingValue(mappingValue(m, "contexts").Content[0], "context")
	if ctx == nil || ctx.Kind != yaml.MappingNode {
		return nil, errors.New("the minted kubeconfig's context has no cluster and user")
	}
	setMappingScalar(ctx, "cluster", name)
	setMappingScalar(ctx, "user", name)
	setMappingScalar(m, "current-context", name)
	return encodeKubeconfig(root), nil
}

// mergeKubeconfig merges the single-entry kubeconfig incoming (already named name) into existing:
// the entries called name are replaced or appended, current-context is set to name, and nothing
// else changes. An empty existing file yields incoming.
func mergeKubeconfig(existing, incoming []byte, name, existingPath string) ([]byte, error) {
	_, in, err := parseKubeconfigMapping(incoming, "the minted kubeconfig")
	if err != nil {
		return nil, err
	}
	if len(bytes.TrimSpace(existing)) == 0 {
		return incoming, nil
	}
	root, m, err := parseKubeconfigMapping(existing, existingPath)
	if err != nil {
		return nil, err
	}
	for _, section := range kubeconfigSections {
		src := mappingValue(in, section)
		if src == nil || src.Kind != yaml.SequenceNode || len(src.Content) != 1 {
			return nil, fmt.Errorf("the minted kubeconfig does not carry exactly one entry under %q", section)
		}
		dst, err := sectionList(m, section, existingPath)
		if err != nil {
			return nil, err
		}
		kept := dst.Content[:0]
		for _, item := range dst.Content {
			if item.Kind == yaml.MappingNode {
				if n := mappingValue(item, "name"); n != nil && n.Value == name {
					continue
				}
			}
			kept = append(kept, item)
		}
		dst.Content = append(kept, src.Content[0])
	}
	if mappingValue(m, "apiVersion") == nil {
		setMappingScalar(m, "apiVersion", "v1")
	}
	if mappingValue(m, "kind") == nil {
		setMappingScalar(m, "kind", "Config")
	}
	setMappingScalar(m, "current-context", name)
	return encodeKubeconfig(root), nil
}

// encodeKubeconfig renders a node tree with kubectl's two-space indent.
func encodeKubeconfig(root *yaml.Node) []byte {
	var buf bytes.Buffer
	enc := yaml.NewEncoder(&buf)
	enc.SetIndent(2)
	// A tree this file parsed or built always encodes; the blank is that fact.
	_ = enc.Encode(root)
	_ = enc.Close()
	return buf.Bytes()
}

// mergeIntoKubeconfig merges doc into the kubeconfig at path under the kubeconfig lock, creating
// the file (and its directory, 0700) when it does not exist.
func mergeIntoKubeconfig(path string, doc []byte, name string) error {
	target, err := resolveWriteTarget(path)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
		return fmt.Errorf("create %s: %w", filepath.Dir(target), err)
	}
	unlock, err := lockKubeconfig(target)
	if err != nil {
		return err
	}
	defer unlock()

	existing, err := os.ReadFile(target)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("read %s: %w", target, err)
	}
	merged, err := mergeKubeconfig(existing, doc, name, target)
	if err != nil {
		return err
	}
	return kubecache.WritePrivateFile(target, merged)
}

// lockKubeconfig takes client-go's lock on a kubeconfig — `<path>.lock`, created exclusively — and
// returns the function that releases it. It waits a few seconds for another writer and then says
// which file to remove if the lock is stale.
func lockKubeconfig(path string) (func(), error) {
	lock := path + ".lock"
	for i := 0; ; i++ {
		f, err := os.OpenFile(lock, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
		if err == nil {
			f.Close()
			return func() { os.Remove(lock) }, nil
		}
		if !errors.Is(err, os.ErrExist) {
			return nil, fmt.Errorf("lock %s: %w", path, err)
		}
		if i+1 >= kubeconfigLockTries {
			return nil, fmt.Errorf("%s is locked by another writer (kubectl?). If nothing else is running, remove %s and try again", path, lock)
		}
		kubeMintSleep(kubeconfigLockRetry)
	}
}

// resolveWriteTarget follows a symlinked kubeconfig to the file it names, so the atomic rename
// replaces that file rather than the link.
func resolveWriteTarget(path string) (string, error) {
	fi, err := os.Lstat(path)
	if err != nil || fi.Mode()&os.ModeSymlink == 0 {
		return path, nil
	}
	target, err := filepath.EvalSymlinks(path)
	if err != nil {
		return "", fmt.Errorf("resolve the symlink %s: %w", path, err)
	}
	return target, nil
}

// writeKubeconfigFile writes a standalone kubeconfig (--output FILE), creating its directory.
func writeKubeconfigFile(path string, doc []byte) error {
	target, err := resolveWriteTarget(path)
	if err != nil {
		return err
	}
	if dir := filepath.Dir(target); dir != "." {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return fmt.Errorf("create %s: %w", dir, err)
		}
	}
	return kubecache.WritePrivateFile(target, doc)
}
