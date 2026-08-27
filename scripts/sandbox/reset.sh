#!/bin/sh
#
# Restore the sandbox repository to the fixture.
#
# The integration tests create, move and delete files, and one of them reverts
# the repository to an earlier commit. A suite whose result depends on what the
# previous run left behind is not a suite, so every run starts here.
#
#   ./scripts/sandbox/reset.sh
#
# The history is rebuilt as several commits with distinct timestamps, because
# planRevert resolves a timestamp to the newest commit at or before it — a
# single-commit history cannot exercise that at all.

set -eu

SANDBOX_REPO="${OTHER_MEMORY_TEST_SANDBOX_REPO:-idin/other-memory-test-sandbox}"

# The one thing this script must never do. Force-pushing a fixture over
# somebody's actual memory would be unrecoverable, and the difference between
# the two repositories is a single environment variable.
case "$SANDBOX_REPO" in
*/keep | keep)
	echo "Refusing to reset '$SANDBOX_REPO': that is the real memory repository." >&2
	exit 1
	;;
esac

case "$SANDBOX_REPO" in
*sandbox*) ;;
*)
	echo "Refusing to reset '$SANDBOX_REPO': the name must contain 'sandbox'," >&2
	echo "so a mistyped repository cannot be force-pushed over." >&2
	exit 1
	;;
esac

repository_root=$(git rev-parse --show-toplevel)
fixture_directory="$repository_root/tests/fixture"

if [ ! -d "$fixture_directory/other-memory" ]; then
	echo "No fixture at $fixture_directory/other-memory" >&2
	exit 1
fi

work_directory=$(mktemp -d)
trap 'rm -rf "$work_directory"' EXIT

echo "Rebuilding $SANDBOX_REPO from the fixture..."

cd "$work_directory"
git init --quiet --initial-branch=main
git config user.email "sandbox@example.invalid"
git config user.name "other-memory sandbox"

# Commit one: the instructions, the rules, and the agent-name tokens. Dated
# well before the rest, so a revert target exists that predates every fact
# in the repository.
mkdir -p other-memory/guidance
cp -R "$fixture_directory/other-memory/guidance/instructions" other-memory/guidance/
cp -R "$fixture_directory/other-memory/guidance/capture_rules" other-memory/guidance/
cp -R "$fixture_directory/other-memory/hidden_from_agents" other-memory/
git add -A
GIT_AUTHOR_DATE="2026-01-05T10:00:00Z" GIT_COMMITTER_DATE="2026-01-05T10:00:00Z" \
	git commit --quiet -m "chore: standing instructions and capture rules"

# Commit two: the facts.
cp -R "$fixture_directory/other-memory/facts" other-memory/
git add -A
GIT_AUTHOR_DATE="2026-01-12T14:30:00Z" GIT_COMMITTER_DATE="2026-01-12T14:30:00Z" \
	git commit --quiet -m "feat: record who this invented person is"

# Commit three: the todo.
cp -R "$fixture_directory/other-memory/work" other-memory/
git add -A
GIT_AUTHOR_DATE="2026-01-15T09:05:00Z" GIT_COMMITTER_DATE="2026-01-15T09:05:00Z" \
	git commit --quiet -m "feat: open a todo about the extractor fan"

# Commit four: the decision log and the message.
cp -R "$fixture_directory/other-memory/guidance/decisions" other-memory/guidance/
cp -R "$fixture_directory/other-memory/messages" other-memory/
git add -A
GIT_AUTHOR_DATE="2026-02-03T09:14:22Z" GIT_COMMITTER_DATE="2026-02-03T09:14:22Z" \
	git commit --quiet -m "feat: decisions for the year, and a message to ada"

git remote add origin "https://github.com/${SANDBOX_REPO}.git"
git push --force --quiet origin main

echo "Reset $SANDBOX_REPO to 4 commits, 2026-01-05 through 2026-02-03."
