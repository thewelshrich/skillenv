# skillenv

[![CI](https://github.com/thewelshrich/skillenv/actions/workflows/ci.yml/badge.svg)](https://github.com/thewelshrich/skillenv/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Virtual environments for agent skills.

Keep one personal skill library. Group skills into named environments. Activate only the environment the current project needs.

```console
$ skillenv add ~/Code/agent-skills/react-best-practices
Added react-best-practices

$ skillenv env create frontend
$ skillenv env add frontend react-best-practices

$ cd ~/Code/my-app
$ skillenv use frontend
Activated frontend in /Users/you/Code/my-app
1 skill available to supported agents.
```

Skillenv materialises real copies into the project paths coding agents already discover:

```text
.agents/skills/       Codex, Cursor, Gemini CLI, OpenCode, Copilot
.claude/skills/       Claude Code compatibility mirror
```

Those copies are local to you. In Git repositories, Skillenv records them in `.git/info/exclude`, not `.gitignore`, so it does not alter the repository for anyone else.

## Install

Skillenv requires Node.js 20 or newer.

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
skillenv add <directory> [--name <name>] [--force]
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

`skillenv add` currently accepts a local directory containing `SKILL.md`. Remote source installation is intentionally outside the first release; existing tools can fetch a skill, and Skillenv can add the resulting directory.

## How it works

Your library and environments live outside projects:

```text
~/.skillenv/
├── skills/
│   ├── react-best-practices/
│   └── playwright/
└── environments/
    └── frontend.json
```

Activation writes a small, locally excluded ownership manifest to `.skillenv/state.json` in the project. Every managed directory has a content hash. Before switching or deactivating, Skillenv verifies those hashes.

This gives Skillenv one strict rule:

> Never overwrite or delete a path it cannot prove it owns.

If you edit a materialised copy, Skillenv reports drift and refuses to remove it. Your source of truth is the library copy under `~/.skillenv/skills`; update that copy and reactivate the environment to deploy it.

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
