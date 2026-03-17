#!/bin/bash
set -e

if [ -z "$1" ]; then
  echo "Usage: $0 <version>"
  echo "Example: $0 0.1.1"
  exit 1
fi

VERSION=$1
TAG="grape-v${VERSION}"

echo "Creating tag ${TAG}..."
# In case the tag already exists locally, we don't want to fail silently or push an old tag
if git rev-parse "${TAG}" >/dev/null 2>&1; then
  echo "Tag ${TAG} already exists locally. Deleting it..."
  git tag -d "${TAG}"
fi

git tag "${TAG}"

echo "Pushing tag ${TAG} to origin..."
# Force push the tag in case we are overwriting an existing remote tag
git push origin "${TAG}" -f

echo "Done! The GitHub Action should now be triggered."
