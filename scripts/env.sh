# source scripts/env.sh  -> Node 24 + compact on PATH (persistent, under ~/workspace)
# The Compact manager lives at ~/workspace/tools/compact/bin/compact and its
# toolchains under ~/workspace/tools/compact/toolchains (COMPACT_DIRECTORY),
# so a VM replacement does not wipe them.
export PATH="$HOME/workspace/tools/compact/bin:$PATH"
export COMPACT_DIRECTORY="$HOME/workspace/tools/compact/toolchains"
