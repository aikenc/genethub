#!/usr/bin/env bash
# Hotfix for v0.3.0-beta.1: the release published only the stable Windows
# installer name, while latest-beta.json pointed at the versioned one. Upload
# the missing copy (same bytes) onto both the tagged and the rolling `beta`
# releases, then refresh SHA256SUMS.
#
# Requires: gh auth (repo scope) and network access to github.com.
set -euo pipefail

repo="${REPO:-aikenc/genethub}"
tag="${TAG:-v0.3.0-beta.1}"
version="${tag#v}"
stable="GeneHub-beta-windows-x64-setup.exe"
versioned="GeneHub-beta-${version}-windows-x64-setup.exe"
workdir="$(mktemp -d)"
trap 'rm -rf "$workdir"' EXIT

cd "$workdir"
echo "downloading $stable from $tag…"
gh release download "$tag" --repo "$repo" --pattern "$stable"
cp "$stable" "$versioned"

upload() {
  local release_tag="$1"
  echo "uploading $versioned → $release_tag"
  gh release upload "$release_tag" "$versioned" --repo "$repo" --clobber

  # Refresh checksums so they cover every asset currently on the release.
  rm -f SHA256SUMS
  gh release download "$release_tag" --repo "$repo" --pattern '*' --dir assets
  (cd assets && sha256sum -- * > ../SHA256SUMS)
  gh release upload "$release_tag" SHA256SUMS --repo "$repo" --clobber
  rm -rf assets SHA256SUMS
}

upload "$tag"
upload beta

echo "done. versioned installer is on $tag and beta."
