# skillenv

[![CI](https://github.com/thewelshrich/skillenv/actions/workflows/ci.yml/badge.svg)](https://github.com/thewelshrich/skillenv/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Follow @RichDevLab on X](https://img.shields.io/badge/follow-%40RichDevLab-black?logo=x)](https://x.com/RichDevLab)

**Virtual environments for agent skills.**

Keep one personal skill library, group skills into named environments, and activate the set you need in each project. Works with Claude Code, Codex, and other agents that read `.claude/skills/` or `.agents/skills/`.

![Activating a frontend environment, confirming Git sees no changes, switching to a review environment, and deactivating](https://raw.githubusercontent.com/thewelshrich/skillenv/main/demo/demo.gif)

## Why

[Agent skills](https://agentskills.io) are folders of instructions your coding agent loads on demand. Collecting them is easy; deciding where to put them is not:

- **Global skills load everywhere.** Put fifty skills in `~/.claude/skills/` and every project sees all fifty. Your agent reads every description, picks the wrong skill more often, and your game-dev skills turn up in your billing service.
- **Project skills are shared.** Commit them to a repository and your personal setup becomes your team's configuration.
- **Copying folders by hand doesn't scale.** The same skills end up maintained separately in every project that needs them. Copies drift from their source, and nothing tells you which version a project has.

Skillenv works like a Python virtualenv for skills. Your library lives in one place. Environments are named sets of skills (`frontend`, `marketing`, `review`), and one environment can serve any number of projects. `skillenv use` copies a set into the current project, keeps it out of Git, and swaps it cleanly when you switch. Update a skill once in your library, then rerun `skillenv use` in any project to pick up the new version.

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

## FAQ

**How is this different from `npx skills add`?** Installers like that put skills directly into a project or your global agent directory. Skillenv installs into a personal library and lets you activate different sets per project, switch between them, and remove them cleanly. You can install from the same sources.

**Why a CLI and not an app?** You already work in a terminal, or next to one. Skillenv is a single command with no desktop app, account, registry, or background service. Your library and environments are plain files in `~/.skillenv/`, so you can inspect, script, or back them up however you like.

**Will my teammates see my skills?** No. Activated skills are excluded through `.git/info/exclude`, which is local to your clone. Nothing is added to `.gitignore` or committed.

**What about skills already in the project or in `~/.claude/skills/`?** Skillenv leaves them alone. It manages only the copies it created and never overwrites or deletes a path it cannot prove it owns.

**Why copy instead of symlink?** Copies are plain directories that any agent can read, and they don't change under a project when you edit or update your library. Recorded content hashes let Skillenv detect edits to project copies before it touches anything.

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

`npm run check` runs typechecking, tests, and the build. Use `npm run dev -- <command>` to run from source. To re-record the demo, run `npm run build` and then `vhs demo/demo.tape`; it uses a sandbox in `/tmp/demo` and never touches `~/.skillenv`. See [CONTRIBUTING.md](CONTRIBUTING.md) to contribute.

## License

MIT
