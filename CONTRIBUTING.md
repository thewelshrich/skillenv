# Contributing to Skillenv

Thanks for helping make Skillenv better.

## Project boundaries

Skillenv should remain a small filesystem CLI with one job: activate named sets of personal agent skills in a local project.

Good contributions improve that workflow, its safety, or compatibility with filesystem-backed coding agents. Marketplaces, accounts, sync services, MCP management, prompt management, and desktop UI are deliberately out of scope.

For a substantial feature, please open an issue before writing the implementation so we can agree on its fit.

## Development

You need Node.js 20 or newer.

```bash
npm install
npm run check
```

Use `npm run dev -- <command>` to run the CLI directly from TypeScript.

## Pull requests

- Keep changes focused and include tests for changed behavior.
- Preserve the rule that Skillenv never overwrites or removes a path it cannot prove it owns.
- Update the README when user-facing behavior changes.
- Run `npm run check` before opening the pull request.

By contributing, you agree that your work will be licensed under the MIT License.
