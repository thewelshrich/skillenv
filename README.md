# skillenv

[![CI](https://github.com/thewelshrich/skillenv/actions/workflows/ci.yml/badge.svg)](https://github.com/thewelshrich/skillenv/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Virtual environments for agent skills.**

Keep one personal skill library, group skills into named environments, and activate the set you need in each project.

Reuse environments across projects and switch sets as your work changes. Skillenv copies skills into your coding agent's discovery directories and locally excludes them from Git, keeping your personal setup out of shared repository configuration.

## Quick start

Requires Node.js 20.12+ and Git for remote sources.

```bash
npm install -g skillenv

# Add a skill to your library and create an environment
skillenv add vercel-labs/agent-skills \
  --skill web-design-guidelines \
  --create-env frontend \
  --yes

# From your project directory
skillenv use frontend
skillenv status
skillenv deactivate
```

Run `skillenv use frontend` in any project to reuse the environment. It stays active there until you switch or deactivate it.

## Everyday use

| Command | What it does |
| --- | --- |
| `skillenv use <environment>` | Activate, switch, or refresh this project's environment |
| `skillenv status` | Show the environment and detect modified or missing copies |
| `skillenv deactivate` | Remove the active environment's project copies |
| `skillenv list` | List skills in your personal library |
| `skillenv update [skills...]` | Update library skills from their sources |
| `skillenv env list` | List saved environments |
| `skillenv env show <name>` | Show the skills in an environment |

Build another environment from installed skills:

```bash
skillenv env create review
skillenv env add review web-design-guidelines
skillenv use review
```

After changing membership with `skillenv env add` or `skillenv env remove <environment> <skill>`, rerun `skillenv use <environment>` to refresh project copies. `skillenv env delete <name>` deletes a definition; deactivate its project copies separately.

## Adding skills

Choose skills, select or create an environment, and optionally activate it interactively:

```bash
skillenv add vercel-labs/agent-skills
```

For scripts, select `--skill <name>` or `--all`, choose a destination, and pass `--yes`:

- `--create-env <name>` creates a new environment.
- `--env <name>` adds to an existing environment.
- `--library-only` installs without changing an environment.

Add `--activate` to activate or refresh the environment here. `--dry-run` previews installation; `--json` provides machine-readable output. See `skillenv add --help` for all options. Non-interactive shells never prompt.

## Updating skills

Skillenv records where each skill came from. `skillenv update` fetches those sources again and updates any library skills whose content has changed:

```bash
skillenv update              # every skill in your library
skillenv update react        # only the named skills
skillenv update --dry-run    # preview without writing
```

Git sources follow the ref they were installed from. Sources pinned to a commit stay put. Local sources are re-read from their original directory.

If you have edited a library copy since installing it, `update` skips it rather than discard your changes; pass `--force` to replace it. Updating changes your library only. Rerun `skillenv use <environment>` in a project to deploy the new versions there.

## How it works

Your library lives in `~/.skillenv/skills/`. Environments are named skill lists under `~/.skillenv/environments/`.

Activation copies skills into the project's `.agents/skills/` and `.claude/skills/` directories for agents that discover those paths, including Codex and Claude Code. Ownership and content hashes are recorded in `.skillenv/state.json`.

Generated files are locally excluded through `.git/info/exclude`; the shared `.gitignore` stays unchanged. Activation also works outside Git, without those excludes.

**An environment controls only Skillenv's managed skills.** Existing project and global skills remain subject to your agent's normal discovery rules.

Skillenv preserves unmanaged skills and refuses to overwrite or delete modified project copies. Edit your library copies and rerun `skillenv use <environment>` to refresh a project. Changes to project copies are reported as drift and block switching or deactivation.

Remote skills run with your coding agent's permissions. Review their `SKILL.md` and supporting files before using them.

## Source reference

<details>
<summary>Source formats, nested skills, and discovery rules</summary>

Sources can be a local directory, GitHub shorthand, or a Git URL:

```text
./my-skill
../company-skills
owner/repository
owner/repository#branch
https://github.com/owner/repository.git
https://github.com/owner/repository/tree/main/path/to/skill
git@github.com:owner/repository.git
```

At a repository root, Skillenv looks for immediate child skills in these directories, in precedence order:

```text
skills/
.agents/skills/
.claude/skills/
.github/skills/
```

If none contain skills, it checks immediate child directories of the source root for a `SKILL.md`. Discovery is one level deep.

Use `--path` to select a nested skill or collection relative to the source root:

```bash
skillenv add owner/repository \
  --path path/to/skill-or-collection \
  --all \
  --library-only \
  --yes
```

Identical mirrored skills are combined into one choice. If skills with the same name differ, Skillenv reports the variants so you can select one with `--path`.

GitHub tree URLs treat the first segment after `/tree/` as the ref. For refs containing `/`, use `owner/repository#feature/name --path path/to/skill`.

Git installs record the resolved commit and content hash in `~/.skillenv/metadata/`, outside project copies.

</details>

## Development

```bash
npm install
npm run check
npm link
```

`npm run check` runs typechecking, tests, and the build. Use `npm run dev -- <command>` to run from source. See [CONTRIBUTING.md](CONTRIBUTING.md) to contribute.

## License

MIT
