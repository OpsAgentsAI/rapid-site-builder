#!/usr/bin/env bash
# Refuse to upload a source tree that contains a symbolic link (card OmZcY0q6).
#
# WHY. `gcloud run deploy --source .` zips the workspace, and Python's
# zipfile.write FOLLOWS file symlinks: a committed `web/innocent.json ->
# /home/runner/.config/gcloud/credentials.db` would put the TARGET's bytes into
# the image under the innocent name, and express.static(web) would serve them.
# `gcloud meta list-files-for-upload` lists such a file under its innocent name,
# so a check on the upload set cannot see it. `sed -i` on a symlinked
# web/index.html also writes through to the target. A git tree records a symlink
# as mode 120000 and actions/checkout materialises it as a real link on Linux.
#
# WHAT. Any symlink under the root, file OR directory, outside .git, refuses.
# Directory symlinks are not followed by the zip walk today, but there is no
# legitimate symlink in this repo and refusing both is the smaller rule to keep
# true. Every deploy workflow that uploads source calls this BEFORE auth, before
# any `sed -i` on web/ and before any `--source .` / `gcloud builds submit .`;
# test/refuse-symlinks.test.js executes it and pins that order in each workflow.
#
# USAGE   bash scripts/refuse-symlinks.sh [ROOT]        (ROOT defaults to .)
# EXIT    0  no symlink under ROOT
#         1  at least one symlink; each is printed as a ::error:: line
#         2  ROOT is not a directory, or the scan itself failed
# Prints link PATHS and their link text only, never the content they point to.
set -euo pipefail

ROOT="${1:-.}"
if [ ! -d "$ROOT" ]; then
  echo "::error::refuse-symlinks: '$ROOT' is not a directory; cannot prove the upload root is symlink-free"
  exit 2
fi
cd "$ROOT"

# Collected into a file, not a pipe, so a failing `find` exits 2 instead of
# reading as an empty (clean) result.
LIST="$(mktemp)"
trap 'rm -f "$LIST"' EXIT
if ! find . -path ./.git -prune -o -type l -print > "$LIST"; then
  echo "::error::refuse-symlinks: scanning '$ROOT' failed; refusing (cannot prove the upload root is symlink-free)"
  exit 2
fi

if [ -s "$LIST" ]; then
  n=0
  while IFS= read -r link; do
    n=$((n + 1))
    echo "::error::symlink in the upload root: ${link#./} -> $(readlink "$link" || echo '?')"
  done < "$LIST"
  echo "::error::REFUSED: $n symlink(s) in the upload root. gcloud's source upload follows file symlinks, so the link target's bytes would ship under the link's name. Replace each link with a real file (or delete it); nothing was uploaded."
  exit 1
fi

echo "refuse-symlinks: no symlink under $(pwd -P) (outside .git)"
