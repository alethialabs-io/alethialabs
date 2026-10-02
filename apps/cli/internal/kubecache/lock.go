// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package kubecache

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

// lockRetry is how often a waiting caller retries the lock. kubectl can start several exec plugins
// at once (a `kubectl get` fans out discovery); the first mints and the rest find its entry, so the
// wait is the length of one mint and the retry granularity only needs to be small beside it.
const lockRetry = 50 * time.Millisecond

// Lock takes the cluster's exclusive lock, waiting until it is free or ctx ends, and returns the
// function that releases it.
//
// It is an OS file lock (flock on Unix, LockFileEx on Windows) on <cluster-id>.lock, so it holds
// across processes — the case it exists for is several kubectl invocations each running `alethia
// cluster token` for a cold cache, which must produce ONE mint, not one each. The lock is released
// by the kernel if the process dies, so a crashed mint never wedges the next call. The lock file is
// left in place on release; deleting it would let a waiter lock an unlinked inode.
func (c *Cache) Lock(ctx context.Context, clusterID string) (func(), error) {
	name, err := fileName(clusterID, "lock")
	if err != nil {
		return nil, err
	}
	path := filepath.Join(c.dir, name)
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, fmt.Errorf("kubecache: open lock %s: %w", path, err)
	}
	for {
		ok, err := tryLock(f)
		if err != nil {
			f.Close()
			return nil, fmt.Errorf("kubecache: lock %s: %w", path, err)
		}
		if ok {
			return func() {
				_ = unlockFile(f)
				f.Close()
			}, nil
		}
		select {
		case <-ctx.Done():
			f.Close()
			return nil, fmt.Errorf("kubecache: waiting for the lock on %s: %w", path, ctx.Err())
		case <-time.After(lockRetry):
		}
	}
}
