# skillenv

[![CI](https://github.com/thewelshrich/skillenv/actions/workflows/ci.yml/badge.svg)](https://github.com/thewelshrich/skillenv/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Virtual environments for agent skills.

Keep one personal skill library. Group skills into named environments. Activate only the environment the current project needs.

```console
$ skillenv add vercel-labs/agent-skills

┌  skillenv
│
◇  Resolving source
│
◆  Select skills to install
│  ◉ vercel-react-best-practices
│  ◉ web-design-guidelines
│
◆  Where should these skills live?
│  ● frontend
│  ○ Create a new environment…
│  ○ Library only
│
◇  Ready
│  2 skills → personal library
│  Update environment frontend
│  Activate in /Users/you/Code/my-app
│
◆  Continue?
│  Yes
│
└  Installed 2 skills into frontend
```

The same workflow remains completely scriptable:

```bash
skillenv add vercel-labs/agent-skills \
  --skill web-design-guidelines \
  --env frontend \
  --activate \
  --yes
```

Switch environments whenever your work changes:

```console
$ skillenv use backend
Activated backend in /Users/you/Code/my-app

$ skillenv deactivate
Deactivated backend
```

Skillenv materialises real copies into the project paths coding agents already discover:

```text
.agents/skills/       Codex, Cursor, Gemini CLI, OpenCode, Copilot
.claude/skills/       Claude Code compatibility mirror
```

Those copies are local to you. In Git repositories, Skillenv records them in `.git/info/exclude`, not `.gitignore`, so it does not alter the repository for anyone else.

## Install

Skillenv requires Node.js 20.12 or newer.

```bash
npm install -g skillenv
```

For local development:

```bash
npm install
npm run build
npm link
```

## Commands

```text
skillenv add [source] [options]
skillenv list

skillenv env create <name>
skillenv env add <environment> <skill>
skillenv env remove <environment> <skill>
skillenv env show <name>
skillenv env list
skillenv env delete <name>

skillenv use <environment>
skillenv status
skillenv deactivate
```

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

When given a repository root, Skillenv discovers immediate child skills in these collection directories, in precedence order:

```text
skills/
.agents/skills/
.claude/skills/
.github/skills/
```

Identical mirrors are coalesced. If copies with the same skill name differ, Skillenv reports the available variants so one can be selected with `--path`.

Select a skill or collection nested inside any source with `--path`:

```bash
skillenv add pbakaus/impeccable \
  --path .agents/skills/impeccable \
  --all \
  --env frontend \
  --yes
```

Paths are relative to the source root. A selected directory can be one skill or a collection whose immediate child directories are skills.
GitHub tree URLs treat the first segment after `/tree/` as the ref. For refs containing `/`, use `owner/repository#feature/name --path path/to/skill`.

Run `skillenv add --help` for selection, environment, activation, dry-run, and JSON options. In a non-interactive shell, Skillenv never prompts: provide `--skill <name>` or `--all`, choose an environment or `--library-only`, and pass `--yes`.

## How it works

Your library and environments live outside projects:

```text
~/.skillenv/
├── skills/
│   ├── react-best-practices/
│   └── playwright/
├── environments/
│   └── frontend.json
└── metadata/
    ├── react-best-practices.json
    └── playwright.json
```

Source metadata is kept outside skill directories, so it is never materialised into projects. Git installs record the resolved commit and content hash for provenance and future updates.

Activation writes a small, locally excluded ownership manifest to `.skillenv/state.json` in the project. Every managed directory has a content hash. Before switching or deactivating, Skillenv verifies those hashes.

This gives Skillenv one strict rule:

> Never overwrite or delete a path it cannot prove it owns.

If you edit a materialised copy, Skillenv reports drift and refuses to remove it. Your source of truth is the library copy under `~/.skillenv/skills`; update that copy and reactivate the environment to deploy it.

Remote skills are untrusted instructions that run with your coding agent's permissions. Review their `SKILL.md` and supporting files before using them.

## Scope

Skillenv is a filesystem CLI for local coding agents. It does not manage MCP servers, prompts, hooks, agent configuration, accounts, marketplaces, cloud workers, or team-wide tracked configuration.

For a non-Git directory, activation still works, but Skillenv cannot hide its generated files from version control and prints a note explaining that.

## Development

```bash
npm test
npm run typecheck
npm run build
```

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for the development workflow and project boundaries.

## License

MIT
