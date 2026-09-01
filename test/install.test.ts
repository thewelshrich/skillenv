import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { install } from "../src/install.js";
import { pathExists } from "../src/fs.js";
import type { InstallInteraction, TargetDecision } from "../src/prompts.js";
import type { Environment } from "../src/schema.js";
import type { SkillCandidate } from "../src/sources.js";

const execFileAsync = promisify(execFile);

class ScriptedInteraction implements InstallInteraction {
  constructor(private readonly answers: { skills?: string[]; target?: TargetDecision; confirm?: boolean } = {}) {}
  intro(): void {}
  async source(): Promise<string> { throw new Error("Unexpected source prompt"); }
  async task<T>(_message: string, operation: () => Promise<T>): Promise<T> { return operation(); }
  async skills(candidates: readonly SkillCandidate[]): Promise<string[]> { return this.answers.skills ?? candidates.map((candidate) => candidate.name); }
  async replace(): Promise<boolean> { return false; }
  async target(_environments: readonly Environment[]): Promise<TargetDecision> { return this.answers.target ?? { kind: "library" }; }
  async environmentName(): Promise<string> { return "frontend"; }
  async activate(): Promise<boolean> { return false; }
  async confirm(): Promise<boolean> { return this.answers.confirm ?? true; }
  success(): void {}
  cancel(): void {}
}

describe("installer", () => {
  let sandbox: string;
  let home: string;
  let project: string;

  beforeEach(async () => {
    sandbox = await mkdtemp(join(tmpdir(), "skillenv-install-"));
    home = join(sandbox, "home");
    project = join(sandbox, "project");
    process.env.SKILLENV_HOME = home;
    await mkdir(project, { recursive: true });
    await execFileAsync("git", ["init", "-q", project]);
  });

  afterEach(async () => {
    delete process.env.SKILLENV_HOME;
    await rm(sandbox, { recursive: true, force: true });
  });

  async function makeCollection(skills: Array<{ name: string; description?: string; body?: string }>): Promise<string> {
    const root = join(sandbox, `source-${Math.random().toString(16).slice(2)}`);
    for (const skill of skills) {
      const directory = join(root, "skills", skill.name);
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "SKILL.md"), `---\nname: ${skill.name}\ndescription: ${skill.description ?? `${skill.name} description`}\n---\n\n${skill.body ?? `# ${skill.name}`}\n`);
    }
    return root;
  }

  it("installs a local collection and records provenance outside copied skills", async () => {
    const source = await makeCollection([{ name: "react" }, { name: "playwright" }]);

    const result = await install({
      source,
      selection: { kind: "all" },
      target: { kind: "library" },
      yes: true,
      cwd: project,
    });

    expect(result.status).toBe("installed");
    expect(await pathExists(join(home, "skills/react/SKILL.md"))).toBe(true);
    expect(await pathExists(join(home, "skills/playwright/SKILL.md"))).toBe(true);
    const metadata = JSON.parse(await readFile(join(home, "metadata/react.json"), "utf8"));
    expect(metadata).toMatchObject({ name: "react", source, sourceKind: "local", sourcePath: "skills/react" });
    expect(await pathExists(join(home, "skills/react/.skillenv.json"))).toBe(false);
  });

  it("creates an environment and activates it in the current project", async () => {
    const source = await makeCollection([{ name: "react" }, { name: "playwright" }]);

    const result = await install({
      source,
      selection: { kind: "named", names: ["react"] },
      target: { kind: "environment", name: "frontend", create: true },
      activate: true,
      yes: true,
      cwd: project,
    });

    expect(result.status).toBe("installed");
    expect(JSON.parse(await readFile(join(home, "environments/frontend.json"), "utf8"))).toMatchObject({ name: "frontend", skills: ["react"] });
    expect(await pathExists(join(project, ".agents/skills/react/SKILL.md"))).toBe(true);
    expect(await pathExists(join(project, ".claude/skills/react/SKILL.md"))).toBe(true);
  });

  it("requires deterministic selection, target, and confirmation", async () => {
    const source = await makeCollection([{ name: "react" }, { name: "playwright" }]);

    await expect(install({ source, yes: true, cwd: project })).rejects.toMatchObject({ code: "INPUT_REQUIRED" });
    await expect(install({ source, selection: { kind: "all" }, yes: true, cwd: project })).rejects.toMatchObject({ code: "INPUT_REQUIRED" });
    await expect(install({ source, selection: { kind: "all" }, target: { kind: "library" }, cwd: project })).rejects.toMatchObject({ code: "INPUT_REQUIRED" });
  });

  it("cancels without durable writes", async () => {
    const source = await makeCollection([{ name: "react" }]);
    const interaction = new ScriptedInteraction({ target: { kind: "library" }, confirm: false });

    const result = await install({ source, cwd: project }, interaction);

    expect(result).toEqual({ status: "cancelled" });
    expect(await pathExists(home)).toBe(false);
  });

  it("supports Git sources, records the revision, and omits repository internals", async () => {
    const repository = join(sandbox, "remote");
    await mkdir(repository, { recursive: true });
    await execFileAsync("git", ["init", "-q", repository]);
    await execFileAsync("git", ["-C", repository, "config", "user.name", "Test"]);
    await execFileAsync("git", ["-C", repository, "config", "user.email", "test@example.com"]);
    await writeFile(join(repository, "SKILL.md"), "---\nname: remote-skill\ndescription: From Git\n---\n\n# Remote\n");
    await execFileAsync("git", ["-C", repository, "add", "SKILL.md"]);
    await execFileAsync("git", ["-C", repository, "commit", "-qm", "initial"]);
    const { stdout } = await execFileAsync("git", ["-C", repository, "rev-parse", "HEAD"], { encoding: "utf8" });

    await install({
      source: `file://${repository}`,
      target: { kind: "library" },
      yes: true,
      cwd: project,
    });

    const metadata = JSON.parse(await readFile(join(home, "metadata/remote-skill.json"), "utf8"));
    expect(metadata.revision).toBe(stdout.trim());
    expect(metadata.sourceKind).toBe("git");
    expect(await pathExists(join(home, "skills/remote-skill/.git"))).toBe(false);
  });

  it("detects conflicts and replaces only when explicitly requested", async () => {
    const first = await makeCollection([{ name: "react", body: "first" }]);
    const second = await makeCollection([{ name: "react", body: "second" }]);
    const base = { selection: { kind: "all" } as const, target: { kind: "library" } as const, yes: true, cwd: project };
    await install({ ...base, source: first });

    await expect(install({ ...base, source: second })).rejects.toMatchObject({ code: "LIBRARY_CONFLICT" });
    expect(await readFile(join(home, "skills/react/SKILL.md"), "utf8")).toContain("first");

    await install({ ...base, source: second, replace: true });
    expect(await readFile(join(home, "skills/react/SKILL.md"), "utf8")).toContain("second");
  });

  it("supports dry runs without creating the Skillenv home", async () => {
    const source = await makeCollection([{ name: "react" }]);
    const result = await install({ source, target: { kind: "library" }, dryRun: true, cwd: project });

    expect(result.status).toBe("planned");
    expect(await pathExists(home)).toBe(false);
  });

  it("rejects symbolic links without leaving transaction state", async () => {
    const source = await makeCollection([{ name: "react" }]);
    const outside = join(sandbox, "outside.md");
    await writeFile(outside, "outside\n");
    await symlink(outside, join(source, "skills/react/linked.md"));

    await expect(install({
      source,
      target: { kind: "library" },
      yes: true,
      cwd: project,
    })).rejects.toThrow("Symbolic links are not supported");

    expect(await pathExists(join(home, "skills/react"))).toBe(false);
    expect(await pathExists(join(home, "transactions"))).toBe(false);
  });
});
