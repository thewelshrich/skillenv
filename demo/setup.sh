#!/usr/bin/env bash
# Builds an isolated sandbox for recording the README demo.
# Nothing here touches your real ~/.skillenv.
#
# Usage: demo/setup.sh [demo-root]   (default: /tmp/skillenv-demo)

set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"
root="${1:-/tmp/skillenv-demo}"

if [ -e "$root" ] && [ ! -e "$root/.skillenv-demo" ]; then
  echo "Refusing to replace $root: it was not created by this script." >&2
  exit 1
fi
rm -rf "$root"
mkdir -p "$root"
touch "$root/.skillenv-demo"
root="$(cd "$root" && pwd -P)"

export SKILLENV_HOME="$root/home"
skillenv() { node "$repo/dist/cli.js" "$@"; }

# A local skill collection standing in for a GitHub repository.
skill() {
  local name="$1" description="$2"
  mkdir -p "$root/team-skills/skills/$name"
  cat > "$root/team-skills/skills/$name/SKILL.md" <<EOF
---
name: $name
description: $description
---

# $name

$description
EOF
}

skill react-patterns "Component structure, hooks, and state conventions for React apps."
skill tailwind "Utility-first styling conventions and design tokens for Tailwind CSS."
skill accessibility "Check UI changes against WCAG 2.2 AA."
skill web-design-guidelines "Review interfaces for layout, typography, and interaction quality."
skill code-review "Review a diff for correctness bugs before merge."
skill security-review "Look for injection, auth, and secrets issues in a change."
skill test-coverage "Find untested behaviour in changed code and propose tests."

skillenv add "$root/team-skills" \
  -s react-patterns -s tailwind -s accessibility -s web-design-guidelines \
  --create-env frontend --yes > /dev/null
skillenv add "$root/team-skills" \
  -s code-review -s security-review -s test-coverage \
  --create-env review --yes > /dev/null

# The project being worked on.
project="$root/acme-web"
mkdir -p "$project/src"
cd "$project"
git init -q
echo '{ "name": "acme-web", "private": true }' > package.json
echo 'export const App = () => null;' > src/App.tsx
git add .
git -c user.name=demo -c user.email=demo@example.com commit -q -m "Initial commit"

echo "$project"
