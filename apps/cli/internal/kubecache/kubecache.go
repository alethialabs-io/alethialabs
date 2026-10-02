// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Package kubecache is the on-disk credential cache behind `alethia cluster token`, the exec plugin
// an Alethia kubeconfig runs on every kubectl call (#5284, #5250 decision 8).
//
// Without it every kubectl call would be a runner round-trip: a mint job queued, claimed, run
// in-network, sealed and polled. With it that cost is paid once per credential lifetime, the way
// gke-gcloud-auth-plugin caches its token.
//
// # Layout
//
// One directory, mode 0700, under the CLI's config dir (DefaultDir). In it, per cluster:
//
//	<cluster-id>.<tier>.json   the credential: token and expiry. Mode 0600.
//	<cluster-id>.profile.json  which tier, TTL and org the exec kubeconfig re-mints with. Mode 0600.
//	<cluster-id>.lock          the lock concurrent kubectl calls serialise on. Empty.
//
// The cluster id must be a canonical lowercase UUID and the tier one of the generated values, so a
// file name is never built from anything that could walk out of the directory. File names carry the
// cluster id and the tier only; nothing derived from a credential is ever part of a name.
//
// # What it refuses
//
// The cache holds bearer credentials, so a read verifies the file before trusting it: it must be a
// regular file (not a symlink), owned by the current user, and readable by nobody else. A file that
// fails is an ErrInsecure, not a miss: a credential that has been readable by others may already
// have been read, and silently minting a fresh one beside it would hide that. (On Windows the mode
// bits do not describe access, which is governed by the ACL inherited from the user's profile
// directory, so the mode and owner checks are skipped there.)
//
// A file that is merely unreadable as an entry — truncated, from an older format, naming another
// cluster — is a MISS: the next Put replaces it atomically.
//
// # Lifetime and logout
//
// A credential is served until MinRemaining (60s) before its expiry, so an entry lives at most its
// TTL: 1h by default, 8h at the outside (--ttl). The re-mint profile has no expiry of its own; it
// is only a recipe, and a re-mint still needs a CLI session.
//
// `alethia logout` deletes the whole directory, for every org (Clear), because a cached credential
// is access obtained through the CLI and logging out ends it (#5323). The next `cluster token` then
// has nothing to serve and must re-mint, which fails until the user logs in again. A logout that
// cannot delete the directory says so on stderr and exits non-zero: a credential left behind
// silently is the defect this exists to prevent. There is no org-scoped logout, so there is no
// per-org clear either.
//
// Clear refuses a cache directory that is a symlink, is not a directory, or is owned by another
// user, the same way Open does: the CLI never wrote a credential there, and deleting through a link
// would delete something it does not own. It deletes nothing outside the directory; os.RemoveAll
// removes a symlink inside it, never what the link points at.
package kubecache

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"time"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// MinRemaining is how long a cached credential must still be valid for to be served. A token that
// expires a few seconds after kubectl receives it fails the request it was fetched for; 60 seconds
// covers a slow apply and the clock skew between this machine and the API server.
const MinRemaining = 60 * time.Second

// maxFileBytes bounds a cache file read. An entry is a few hundred bytes plus the token; a cloud
// token is at most a few KiB. Anything larger is not an entry this package wrote.
const maxFileBytes = 64 << 10

// ErrInsecure is wrapped when a cache file or the directory is not private to the current user.
var ErrInsecure = errors.New("kubecache: insecure cache file")

// ErrInvalidKey is wrapped when a cluster id or tier cannot name a cache file.
var ErrInvalidKey = errors.New("kubecache: invalid cache key")

// canonicalUUID is the only cluster id shape a file name may be built from.
var canonicalUUID = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

// Entry is one cached credential: the bearer token an exec kubeconfig hands kubectl, and when it
// expires. Its Format method redacts the token, so an Entry printed by accident prints no secret.
type Entry struct {
	ClusterID string                   `json:"cluster_id"`
	Tier      types.KubeconfigMintTier `json:"tier"`
	Token     string                   `json:"token"`
	ExpiresAt time.Time                `json:"expires_at"`
}

// Format implements fmt.Formatter so every verb (%v, %+v, %s, %#v) renders the entry with the token
// replaced. The credential must never reach a log or an error by way of a formatted struct.
func (e Entry) Format(f fmt.State, _ rune) {
	fmt.Fprintf(f, "kubecache.Entry{cluster=%s tier=%s token=<redacted> expires=%s}",
		e.ClusterID, e.Tier, e.ExpiresAt.UTC().Format(time.RFC3339))
}

// FreshAt reports whether the entry can still be served at now: valid for at least MinRemaining.
func (e Entry) FreshAt(now time.Time) bool {
	return e.ExpiresAt.Sub(now) >= MinRemaining
}

// Profile is what `alethia cluster token` re-mints with when the cached credential has lapsed: the
// tier and TTL the user chose with `alethia cluster kubeconfig`, and the org the cluster is in.
//
// The exec kubeconfig's arguments name only the cluster (kubeaccess.RenderExecKubeconfig), so this
// record is how a later kubectl call knows that the user asked for --admin, or --ttl 4h. The org is
// recorded because the CLI's active org can change after the kubeconfig was written, and a mint
// scoped to another org answers 404 for this cluster.
type Profile struct {
	ClusterID  string                   `json:"cluster_id"`
	Tier       types.KubeconfigMintTier `json:"tier"`
	TTLSeconds int                      `json:"ttl_seconds"`
	OrgID      string                   `json:"org_id,omitempty"`
}

// Cache is the cache directory. The zero value is not usable; call Open.
type Cache struct {
	dir string
}

// DefaultDir is the cache directory under the CLI's config dir (next to credentials.json).
func DefaultDir() (string, error) {
	base, err := os.UserConfigDir()
	if err != nil {
		return "", fmt.Errorf("kubecache: locate the config dir: %w", err)
	}
	return filepath.Join(base, "alethia", "kubecache"), nil
}

// Open creates dir (mode 0700) if it is missing and returns the cache in it. An existing directory
// that is group- or world-accessible is tightened to 0700, the way credentials.json is repaired on
// write; a directory that is a symlink, or owned by someone else, is refused.
func Open(dir string) (*Cache, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("kubecache: create %s: %w", dir, err)
	}
	fi, err := os.Lstat(dir)
	if err != nil {
		return nil, fmt.Errorf("kubecache: stat %s: %w", dir, err)
	}
	if !fi.IsDir() {
		return nil, fmt.Errorf("%w: %s is not a directory", ErrInsecure, dir)
	}
	if err := checkOwner(fi); err != nil {
		return nil, fmt.Errorf("%w: %s %v", ErrInsecure, dir, err)
	}
	if permsOpen(fi) {
		if err := os.Chmod(dir, 0o700); err != nil {
			return nil, fmt.Errorf("kubecache: tighten %s to 0700: %w", dir, err)
		}
	}
	return &Cache{dir: dir}, nil
}

// Clear deletes the cache directory dir and everything in it, and reports whether there was one to
// delete. A missing directory is (false, nil). A directory that is a symlink, is not a directory,
// or is owned by another user is refused with an error wrapping ErrInsecure and left untouched. Any
// other failure is an error naming dir.
func Clear(dir string) (bool, error) {
	fi, err := os.Lstat(dir)
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("kubecache: stat %s: %w", dir, err)
	}
	if fi.Mode()&os.ModeSymlink != 0 {
		return false, fmt.Errorf("%w: %s is a symlink; refusing to delete through it — delete it yourself", ErrInsecure, dir)
	}
	if !fi.IsDir() {
		return false, fmt.Errorf("%w: %s is not a directory; delete it yourself", ErrInsecure, dir)
	}
	if err := checkOwner(fi); err != nil {
		return false, fmt.Errorf("%w: %s %v; delete it yourself", ErrInsecure, dir, err)
	}
	if err := os.RemoveAll(dir); err != nil {
		return false, fmt.Errorf("kubecache: delete %s: %w", dir, err)
	}
	return true, nil
}

// Dir is the directory the cache lives in.
func (c *Cache) Dir() string { return c.dir }

// fileName builds a cache file name from a validated cluster id and suffix.
func fileName(clusterID, suffix string) (string, error) {
	if !canonicalUUID.MatchString(clusterID) {
		return "", fmt.Errorf("%w: cluster id %q is not a canonical lowercase uuid", ErrInvalidKey, clusterID)
	}
	return clusterID + "." + suffix, nil
}

// entryName is the credential file's name for a cluster and tier.
func entryName(clusterID string, tier types.KubeconfigMintTier) (string, error) {
	if !validTier(tier) {
		return "", fmt.Errorf("%w: unknown tier %q", ErrInvalidKey, tier)
	}
	return fileName(clusterID, string(tier)+".json")
}

// validTier reports whether tier is a generated KubeconfigMintTier.
func validTier(tier types.KubeconfigMintTier) bool {
	for _, t := range types.AllKubeconfigMintTiers {
		if t == tier {
			return true
		}
	}
	return false
}

// Get returns the cached credential for a cluster and tier, or nil when there is none (or the file
// is not a readable entry). It does not judge freshness; the caller asks FreshAt. An insecure file
// is an error wrapping ErrInsecure.
func (c *Cache) Get(clusterID string, tier types.KubeconfigMintTier) (*Entry, error) {
	name, err := entryName(clusterID, tier)
	if err != nil {
		return nil, err
	}
	data, err := c.read(name)
	if err != nil || data == nil {
		return nil, err
	}
	var e Entry
	if json.Unmarshal(data, &e) != nil || e.ClusterID != clusterID || e.Tier != tier ||
		e.Token == "" || e.ExpiresAt.IsZero() {
		return nil, nil
	}
	return &e, nil
}

// Put stores a credential, replacing any previous entry for its cluster and tier atomically.
func (c *Cache) Put(e Entry) error {
	name, err := entryName(e.ClusterID, e.Tier)
	if err != nil {
		return err
	}
	if e.Token == "" || e.ExpiresAt.IsZero() {
		return fmt.Errorf("kubecache: refusing to cache an entry with no token or no expiry")
	}
	// An Entry of strings and a time cannot fail to marshal.
	data, _ := json.Marshal(e)
	return c.write(name, data)
}

// Profile returns the re-mint profile recorded for a cluster, and whether one was.
func (c *Cache) Profile(clusterID string) (Profile, bool, error) {
	name, err := fileName(clusterID, "profile.json")
	if err != nil {
		return Profile{}, false, err
	}
	data, err := c.read(name)
	if err != nil || data == nil {
		return Profile{}, false, err
	}
	var p Profile
	if json.Unmarshal(data, &p) != nil || p.ClusterID != clusterID || !validTier(p.Tier) ||
		types.ValidateKubeconfigMintTTL(p.TTLSeconds) != nil {
		return Profile{}, false, nil
	}
	return p, true, nil
}

// SetProfile records the re-mint profile for a cluster, replacing any previous one atomically.
func (c *Cache) SetProfile(p Profile) error {
	name, err := fileName(p.ClusterID, "profile.json")
	if err != nil {
		return err
	}
	if !validTier(p.Tier) {
		return fmt.Errorf("%w: unknown tier %q", ErrInvalidKey, p.Tier)
	}
	if err := types.ValidateKubeconfigMintTTL(p.TTLSeconds); err != nil {
		return fmt.Errorf("kubecache: %w", err)
	}
	data, _ := json.Marshal(p)
	return c.write(name, data)
}

// read returns a cache file's bytes, nil when it does not exist, or an error when it is not a
// private regular file. The file is checked by Lstat (so a symlink is seen as one) and again
// through the open handle, so a file swapped between the two is refused rather than read.
func (c *Cache) read(name string) ([]byte, error) {
	path := filepath.Join(c.dir, name)
	before, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("kubecache: stat %s: %w", path, err)
	}
	if err := checkPrivate(before); err != nil {
		return nil, fmt.Errorf("%w: %s %v — delete it and run the command again", ErrInsecure, path, err)
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("kubecache: open %s: %w", path, err)
	}
	defer f.Close()
	after, err := f.Stat()
	if err != nil || !os.SameFile(before, after) {
		return nil, fmt.Errorf("%w: %s changed while it was being read", ErrInsecure, path)
	}
	data, err := io.ReadAll(io.LimitReader(f, maxFileBytes+1))
	if err != nil {
		return nil, fmt.Errorf("kubecache: read %s: %w", path, err)
	}
	if len(data) > maxFileBytes {
		return nil, nil
	}
	return data, nil
}

// checkPrivate refuses anything but a regular file owned by the current user with no group or
// other permission bits.
func checkPrivate(fi os.FileInfo) error {
	if !fi.Mode().IsRegular() {
		return fmt.Errorf("is not a regular file (mode %s)", fi.Mode())
	}
	if err := checkOwner(fi); err != nil {
		return err
	}
	if permsOpen(fi) {
		return fmt.Errorf("is accessible by group or others (mode %#o)", fi.Mode().Perm())
	}
	return nil
}

// write replaces a cache file atomically (WritePrivateFile).
func (c *Cache) write(name string, data []byte) error {
	if err := WritePrivateFile(filepath.Join(c.dir, name), data); err != nil {
		return fmt.Errorf("kubecache: %w", err)
	}
	return nil
}

// WritePrivateFile replaces path with data at mode 0600: a temp file in the same directory, synced,
// then renamed over the target. A reader (or a crash) sees the old file or the new one, never half
// of either. It is exported because a kubeconfig the CLI writes is a credential too, and one
// implementation of "write a secret to disk" is easier to keep right than two.
func WritePrivateFile(path string, data []byte) error {
	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, "."+filepath.Base(path)+".*.tmp")
	if err != nil {
		return fmt.Errorf("create a temp file in %s: %w", dir, err)
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath) // a no-op once the rename has happened
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return fmt.Errorf("chmod %s: %w", tmpPath, err)
	}
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return fmt.Errorf("write %s: %w", tmpPath, err)
	}
	tmp.Sync()
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("close %s: %w", tmpPath, err)
	}
	if err := os.Rename(tmpPath, path); err != nil {
		return fmt.Errorf("replace %s: %w", path, err)
	}
	return nil
}
