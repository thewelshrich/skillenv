import { execFile } from "node:child_process";
import { chmod, lstat, mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { install, installPlanLines } from "../src/install.js";
import { addEnvironmentSkill, createEnvironment, putEnvironmentSkills } from "../src/environments.js";
import { fingerprintEntry, hashDirectory, pathExists } from "../src/fs.js";
import { installLibrarySkills } from "../src/library.js";
import type { InstallInteraction, TargetDecision } from "../src/prompts.js";
import type { Environment } from "../src/schema.js";
import { resolveSource, sanitizeSourceInput, type SkillCandidate } from "../src/sources.js";

const execFileAsync = promisify(execFile);

class ScriptedInteraction implements InstallInteraction {
  previewed = false;
  constructor(private readonly answers: { skills?: string[]; target?: TargetDecision; replace?: boolean; confirm?: boolean; onConfirm?: () => Promise<void> } = {}) {}
  intro(): void {}
  async source(): Promise<string> { throw new Error("Unexpected source prompt"); }
  async task<T>(_message: string, operation: () => Promise<T>): Promise<T> { return operation(); }
  async skills(candidates: readonly SkillCandidate[]): Promise<string[]> { return this.answers.skills ?? candidates.map((candidate) => candidate.name); }
  async replace(): Promise<boolean> { return this.answers.replace ?? false; }
  async target(_environments: readonly Environment[]): Promise<TargetDecision> { return this.answers.target ?? { kind: "library" }; }
  async environmentName(): Promise<string> { return "frontend"; }
  async activate(): Promise<boolean> { return false; }
  preview(): void { this.previewed = true; }
  async confirm(): Promise<boolean> {
    await this.answers.onConfirm?.();
    return this.answers.confirm ?? true;
  }
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

  it("redacts credentials from persisted source provenance", () => {
    expect(sanitizeSourceInput("https://token:secret@example.com/owner/repo.git#main"))
      .toBe("https://example.com/owner/repo.git#main");
    expect(sanitizeSourceInput("ssh://user:secret@example.com/owner/repo.git"))
      .toBe("ssh://example.com/owner/repo.git");
  });

  it("rejects empty source input", async () => {
    await expect(install({ source: "   ", target: { kind: "library" }, dryRun: true, cwd: project }))
      .rejects.toMatchObject({ code: "INPUT_REQUIRED" });
  });

  it("rejects explicitly empty Git refs", async () => {
    await expect(resolveSource("owner/repo#")).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("preserves significant whitespace in explicit local source paths", async () => {
    const trimmed = join(sandbox, "company-skill");
    const exact = `${trimmed} `;
    await mkdir(join(trimmed, "skills", "wrong"), { recursive: true });
    await writeFile(join(trimmed, "skills", "wrong", "SKILL.md"), "---\nname: wrong\n---\n");
    await mkdir(join(exact, "skills", "right"), { recursive: true });
    await writeFile(join(exact, "skills", "right", "SKILL.md"), "---\nname: right\n---\n");

    const result = await install({ source: exact, target: { kind: "library" }, dryRun: true, cwd: project });

    expect(result.status).toBe("planned");
    if (result.status === "planned") expect(result.plan.skills).toEqual(["right"]);
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

  it("restores the prior project, environment, and library when activation fails", async () => {
    const first = await makeCollection([{ name: "react", body: "original" }]);
    await install({
      source: first,
      target: { kind: "environment", name: "frontend", create: true },
      activate: true,
      yes: true,
      cwd: project,
    });
    const gitExclude = join(project, ".git/info/exclude");
    await rm(gitExclude);
    await mkdir(gitExclude);
    const second = await makeCollection([{ name: "react", body: "replacement" }]);

    await expect(install({
      source: second,
      target: { kind: "environment", name: "backend", create: true },
      activate: true,
      replace: true,
      yes: true,
      cwd: project,
    })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });

    expect(JSON.parse(await readFile(join(project, ".skillenv/state.json"), "utf8"))).toMatchObject({ environment: "frontend" });
    expect(await pathExists(join(project, ".agents/skills/react/SKILL.md"))).toBe(true);
    expect(await readFile(join(project, ".agents/skills/react/SKILL.md"), "utf8")).toContain("original");
    expect(await pathExists(join(home, "environments/backend.json"))).toBe(true);
    expect(await readFile(join(home, "skills/react/SKILL.md"), "utf8")).toContain("replacement");
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

  it("reconfirms conflicts that appear after an interactive plan", async () => {
    const installed = await makeCollection([{ name: "react", body: "old" }]);
    await install({ source: installed, target: { kind: "library" }, yes: true, cwd: project });
    const source = await makeCollection([{ name: "react", body: "new" }, { name: "playwright" }]);
    const interaction = new ScriptedInteraction({
      target: { kind: "library" },
      replace: true,
      onConfirm: async () => {
        await mkdir(join(home, "skills/playwright"), { recursive: true });
        await writeFile(join(home, "skills/playwright/SKILL.md"), "concurrent\n");
      },
    });

    await expect(install({ source, selection: { kind: "all" }, cwd: project }, interaction))
      .rejects.toMatchObject({ code: "LIBRARY_CONFLICT_CHANGED" });
    expect(await readFile(join(home, "skills/react/SKILL.md"), "utf8")).toContain("old");
  });

  it("supports dry runs without creating the Skillenv home", async () => {
    const source = await makeCollection([{ name: "react" }]);
    const result = await install({ source, target: { kind: "library" }, dryRun: true, cwd: project });

    expect(result.status).toBe("planned");
    expect(await pathExists(home)).toBe(false);
  });

  it("does not recover interrupted activation state during a dry run", async () => {
    const source = await makeCollection([{ name: "react" }]);
    await install({ source, target: { kind: "environment", name: "frontend", create: true }, yes: true, cwd: project });
    const interrupted = join(project, ".skillenv/staging-interrupted");
    await mkdir(interrupted, { recursive: true });

    const result = await install({
      source,
      target: { kind: "environment", name: "frontend", create: false },
      activate: true,
      dryRun: true,
      cwd: project,
    });

    expect(result.status).toBe("planned");
    expect(await pathExists(interrupted)).toBe(true);
  });

  it("renders a dry-run preview in interactive mode", async () => {
    const source = await makeCollection([{ name: "react" }]);
    const interaction = new ScriptedInteraction({ target: { kind: "library" } });

    const result = await install({ source, dryRun: true, cwd: project }, interaction);

    expect(result.status).toBe("planned");
    expect(interaction.previewed).toBe(true);
    expect(await pathExists(home)).toBe(false);
  });

  it("validates new environment names during planning", async () => {
    const source = await makeCollection([{ name: "react" }]);

    await expect(install({
      source,
      target: { kind: "environment", name: "../frontend", create: true },
      dryRun: true,
      cwd: project,
    })).rejects.toThrow();

    expect(await pathExists(home)).toBe(false);
  });

  it("records provenance for unchanged legacy skills", async () => {
    const source = await makeCollection([{ name: "react" }]);
    await mkdir(join(home, "skills/react"), { recursive: true });
    await writeFile(join(home, "skills/react/SKILL.md"), await readFile(join(source, "skills/react/SKILL.md")));

    const result = await install({ source, target: { kind: "library" }, yes: true, cwd: project });

    expect(result.status).toBe("installed");
    expect(await pathExists(join(home, "metadata/react.json"))).toBe(true);
  });

  it("can replace an unhashable legacy library entry when forced", async () => {
    const source = await makeCollection([{ name: "react", body: "replacement" }]);
    await mkdir(join(home, "skills/react"), { recursive: true });
    await writeFile(join(home, "skills/react/SKILL.md"), "legacy\n");
    await symlink(join(sandbox, "missing"), join(home, "skills/react/broken"));

    const result = await install({ source, target: { kind: "library" }, replace: true, yes: true, cwd: project });

    expect(result.status).toBe("installed");
    expect(await readFile(join(home, "skills/react/SKILL.md"), "utf8")).toContain("replacement");
  });

  it("can replace a legacy root symlink when forced", async () => {
    const source = await makeCollection([{ name: "react", body: "replacement" }]);
    const outside = join(sandbox, "outside-skill");
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "SKILL.md"), await readFile(join(source, "skills/react/SKILL.md")));
    await mkdir(join(home, "skills"), { recursive: true });
    await symlink(outside, join(home, "skills/react"));

    await install({ source, target: { kind: "library" }, replace: true, yes: true, cwd: project });

    expect((await lstat(join(home, "skills/react"))).isSymbolicLink()).toBe(false);
  });

  it("allows force to replace orphaned metadata", async () => {
    const source = await makeCollection([{ name: "react" }]);
    await mkdir(join(home, "metadata"), { recursive: true });
    await writeFile(join(home, "metadata/react.json"), "{}\n");
    const request = { source, target: { kind: "library" } as const, yes: true, cwd: project };

    await expect(install(request)).rejects.toMatchObject({ code: "LIBRARY_CONFLICT" });
    const result = await install({ ...request, replace: true });

    expect(result.status).toBe("installed");
    expect(await pathExists(join(home, "skills/react/SKILL.md"))).toBe(true);
  });

  it("does not inspect project state for an explicit library-only install", async () => {
    const source = await makeCollection([{ name: "react" }]);
    await mkdir(join(project, ".skillenv"), { recursive: true });
    await writeFile(join(project, ".skillenv/state.json"), "not json\n");

    const result = await install({ source, target: { kind: "library" }, yes: true, cwd: project });

    expect(result.status).toBe("installed");
  });

  it("does not enumerate malformed environments for a library-only install", async () => {
    const source = await makeCollection([{ name: "react" }]);
    await mkdir(join(home, "environments"), { recursive: true });
    await writeFile(join(home, "environments/broken.json"), "not json\n");

    const result = await install({ source, target: { kind: "library" }, yes: true, cwd: project });

    expect(result.status).toBe("installed");
  });

  it("validates only an explicitly targeted environment", async () => {
    const first = await makeCollection([{ name: "react" }]);
    await install({ source: first, target: { kind: "environment", name: "frontend", create: true }, yes: true, cwd: project });
    await writeFile(join(home, "environments/broken.json"), "not json\n");
    const second = await makeCollection([{ name: "playwright" }]);

    const result = await install({ source: second, target: { kind: "environment", name: "frontend", create: false }, dryRun: true, cwd: project });

    expect(result.status).toBe("planned");
  });

  it("formats complete human-readable installation plans", () => {
    expect(installPlanLines({
      source: "safe/source",
      skills: ["react", "playwright"],
      replacing: ["react"],
      unchanged: ["playwright"],
      target: { kind: "environment", name: "frontend", create: false },
      activate: true,
      projectRoot: project,
    })).toEqual([
      "Skills (2): react, playwright",
      "Target: personal library",
      "Replace: react",
      "Already current: playwright",
      "Environment: update frontend",
      `Activation: ${project}`,
    ]);
  });

  it("does not reinterpret local path errors as GitHub shorthand", async () => {
    const parent = join(sandbox, "skills");
    await writeFile(parent, "not a directory\n");

    await expect(resolveSource(join(parent, "react"))).rejects.toMatchObject({ code: "ENOTDIR" });
  });

  it("does not reinterpret missing explicit relative paths as GitHub shorthand", async () => {
    await expect(resolveSource(`./missing-${Math.random().toString(16).slice(2)}`))
      .rejects.toMatchObject({ code: "SOURCE_UNSUPPORTED" });
  });

  it("rejects existing non-directory sources before remote fallback", async () => {
    const source = join(sandbox, "owner/repo");
    await mkdir(join(sandbox, "owner"), { recursive: true });
    await writeFile(source, "not a repository\n");

    await expect(resolveSource(source)).rejects.toMatchObject({ code: "SOURCE_UNSUPPORTED" });
  });

  it("names an unnamed remote root skill after its repository", async () => {
    const repository = join(sandbox, "delightful-skill");
    await mkdir(repository, { recursive: true });
    await writeFile(join(repository, "SKILL.md"), "# Delightful\n");
    await execFileAsync("git", ["init", "-q", repository]);
    await execFileAsync("git", ["-C", repository, "add", "SKILL.md"]);
    await execFileAsync("git", ["-C", repository, "-c", "user.name=Skillenv Tests", "-c", "user.email=tests@skillenv.dev", "commit", "-qm", "fixture"]);

    const resolved = await resolveSource(`file://${repository}`);
    try {
      expect(resolved.skills.map((skill) => skill.name)).toEqual(["delightful-skill"]);
    } finally {
      await resolved.cleanup();
    }
  });

  it("sanitizes untrusted discovered paths in duplicate-name errors", async () => {
    const root = join(sandbox, "unsafe-paths");
    for (const directory of ["first\u001b[31m", "second"]) {
      await mkdir(join(root, "skills", directory), { recursive: true });
      await writeFile(join(root, "skills", directory, "SKILL.md"), "---\nname: duplicate\n---\n");
    }

    const error = await resolveSource(root).catch((caught: unknown) => caught as Error);
    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) throw new Error("Expected source discovery to fail");
    expect(error.message).not.toContain("\u001b");
    expect(error.message).toContain("first [31m");
  });

  it("treats executable mode changes as library conflicts", async () => {
    const source = await makeCollection([{ name: "react" }]);
    const base = { source, target: { kind: "library" } as const, yes: true, cwd: project };
    await install(base);
    await chmod(join(source, "skills/react/SKILL.md"), 0o755);

    const result = await install({ ...base, replace: true, dryRun: true });

    expect(result.status).toBe("planned");
    if (result.status === "planned") expect(result.plan.replacing).toEqual(["react"]);
  });

  it("treats skill root mode changes as library conflicts", async () => {
    const source = await makeCollection([{ name: "react" }]);
    const base = { source, target: { kind: "library" } as const, yes: true, cwd: project };
    await install(base);
    await chmod(join(source, "skills/react"), 0o700);

    const result = await install({ ...base, replace: true, dryRun: true });

    expect(result.status).toBe("planned");
    if (result.status === "planned") expect(result.plan.replacing).toEqual(["react"]);
  });

  it("rejects case aliases of skills already in the library", async () => {
    await install({ source: await makeCollection([{ name: "react" }]), target: { kind: "library" }, yes: true, cwd: project });
    const alias = await makeCollection([{ name: "React" }]);

    await expect(install({ source: alias, target: { kind: "library" }, yes: true, cwd: project }))
      .rejects.toMatchObject({ code: "DUPLICATE_SKILL" });
  });

  it("rejects case aliases of legacy non-directory library entries", async () => {
    const outside = join(sandbox, "legacy-react");
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "SKILL.md"), "legacy\n");
    await mkdir(join(home, "skills"), { recursive: true });
    await symlink(outside, join(home, "skills/react"));

    await expect(install({ source: await makeCollection([{ name: "React" }]), target: { kind: "library" }, dryRun: true, cwd: project }))
      .rejects.toMatchObject({ code: "DUPLICATE_SKILL" });
  });

  it("rejects special filesystem entries during dry-run validation", async () => {
    const source = await makeCollection([{ name: "react" }]);
    await execFileAsync("mkfifo", [join(source, "skills/react/pipe")]);

    await expect(install({ source, target: { kind: "library" }, dryRun: true, cwd: project }))
      .rejects.toThrow("Unsupported filesystem entry");
  });

  it("serializes concurrent library updates", async () => {
    const firstSource = await resolveSource(await makeCollection([{ name: "react" }]));
    const secondSource = await resolveSource(await makeCollection([{ name: "playwright" }]));
    const change = await installLibrarySkills(firstSource.skills, { input: firstSource.input, kind: firstSource.kind, revision: null }, { replace: false });
    try {
      await expect(installLibrarySkills(secondSource.skills, { input: secondSource.input, kind: secondSource.kind, revision: null }, { replace: false }))
        .rejects.toMatchObject({ code: "LIBRARY_BUSY" });
    } finally {
      await change.finalize();
    }
  });

  it("preserves modified installed library copies during rollback", async () => {
    const resolved = await resolveSource(await makeCollection([{ name: "react" }]));
    const change = await installLibrarySkills(resolved.skills, { input: resolved.input, kind: resolved.kind, revision: null }, { replace: false });
    await writeFile(join(home, "skills/react/SKILL.md"), "user edit\n");

    await expect(change.rollback()).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    expect(await readFile(join(home, "skills/react/SKILL.md"), "utf8")).toBe("user edit\n");
  });

  it("refuses to replace a library copy edited after inspection", async () => {
    await install({ source: await makeCollection([{ name: "react", body: "old" }]), target: { kind: "library" }, yes: true, cwd: project });
    const replacement = await resolveSource(await makeCollection([{ name: "react", body: "new" }]));
    const editDuringStaging = (async () => {
      for (let attempt = 0; attempt < 5000; attempt += 1) {
        const transactions = await readdir(join(home, "transactions"), { withFileTypes: true }).catch(() => []);
        if (transactions.some((entry) => entry.isDirectory() && entry.name !== "locks")) {
          await writeFile(join(home, "skills/react/SKILL.md"), "late edit\n");
          return;
        }
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      throw new Error("Installation did not enter staging");
    })();

    await expect(installLibrarySkills(replacement.skills, { input: replacement.input, kind: replacement.kind, revision: null }, { replace: true }))
      .rejects.toMatchObject({ code: "LIBRARY_CONFLICT_CHANGED" });
    await editDuringStaging;
    expect(await readFile(join(home, "skills/react/SKILL.md"), "utf8")).toBe("late edit\n");
    await replacement.cleanup();
  });

  it("revalidates legacy library copies during metadata-only installs", async () => {
    const sourcePath = await makeCollection([{ name: "react" }]);
    await mkdir(join(home, "skills/react"), { recursive: true });
    await writeFile(join(home, "skills/react/SKILL.md"), await readFile(join(sourcePath, "skills/react/SKILL.md")));
    const resolved = await resolveSource(sourcePath);
    const editDuringStaging = (async () => {
      for (let attempt = 0; attempt < 5000; attempt += 1) {
        const transactions = await readdir(join(home, "transactions"), { withFileTypes: true }).catch(() => []);
        const staging = transactions.find((entry) => entry.isDirectory() && entry.name !== "locks");
        if (staging && await pathExists(join(home, "transactions", staging.name, "staged/metadata/react.json"))) {
          await writeFile(join(home, "skills/react/SKILL.md"), "late edit\n");
          return;
        }
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      throw new Error("Installation did not enter staging");
    })();

    await expect(installLibrarySkills(resolved.skills, { input: resolved.input, kind: resolved.kind, revision: null }, { replace: false }))
      .rejects.toMatchObject({ code: "LIBRARY_CONFLICT_CHANGED" });
    await editDuringStaging;
    expect(await readFile(join(home, "skills/react/SKILL.md"), "utf8")).toBe("late edit\n");
  });

  it("preserves new library destinations created while staging", async () => {
    const resolved = await resolveSource(await makeCollection([{ name: "react" }]));
    const createDuringStaging = (async () => {
      for (let attempt = 0; attempt < 5000; attempt += 1) {
        const transactions = await readdir(join(home, "transactions"), { withFileTypes: true }).catch(() => []);
        const staging = transactions.find((entry) => entry.isDirectory() && entry.name !== "locks");
        if (staging && await pathExists(join(home, "transactions", staging.name, "staged/skills/react"))) {
          await mkdir(join(home, "skills/react"), { recursive: true });
          await writeFile(join(home, "skills/react/SKILL.md"), "unmanaged\n");
          return;
        }
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      throw new Error("Installation did not enter staging");
    })();

    await expect(installLibrarySkills(resolved.skills, { input: resolved.input, kind: resolved.kind, revision: null }, { replace: false }))
      .rejects.toMatchObject({ code: "LIBRARY_CONFLICT_CHANGED" });
    await createDuringStaging;
    expect(await readFile(join(home, "skills/react/SKILL.md"), "utf8")).toBe("unmanaged\n");
  });

  it("recovers an interrupted library transaction before installing", async () => {
    const interrupted = join(home, "transactions/interrupted");
    await mkdir(join(home, "skills/react"), { recursive: true });
    await writeFile(join(home, "skills/react/SKILL.md"), "original\n");
    await mkdir(join(interrupted, "backup/skills"), { recursive: true });
    await rename(join(home, "skills/react"), join(interrupted, "backup/skills/react"));
    const previousEnvironment = { version: 1 as const, name: "frontend", skills: ["react"] };
    const nextEnvironment = { version: 1 as const, name: "frontend", skills: ["playwright", "react"] };
    await mkdir(join(home, "environments"), { recursive: true });
    await writeFile(join(home, "environments/frontend.json"), `${JSON.stringify(nextEnvironment, null, 2)}\n`);
    await writeFile(join(interrupted, "journal.json"), `${JSON.stringify({
      version: 1,
      phase: "prepared",
      entries: [{ name: "react", metadataOnly: false, hadSkill: true, hadMetadata: false, installedHash: "a".repeat(64) }],
      environment: { name: "frontend", previous: previousEnvironment, next: nextEnvironment },
    })}\n`);
    const source = await makeCollection([{ name: "playwright" }]);

    await install({ source, target: { kind: "library" }, yes: true, cwd: project });

    expect(await readFile(join(home, "skills/react/SKILL.md"), "utf8")).toBe("original\n");
    expect(JSON.parse(await readFile(join(home, "environments/frontend.json"), "utf8"))).toEqual(previousEnvironment);
    expect(await pathExists(join(home, "skills/playwright/SKILL.md"))).toBe(true);
    expect(await pathExists(interrupted)).toBe(false);
  });

  it("preserves edits to a skill from an interrupted library install", async () => {
    const interrupted = join(home, "transactions/interrupted");
    await mkdir(join(interrupted, "backup/skills/react"), { recursive: true });
    await writeFile(join(interrupted, "backup/skills/react/SKILL.md"), "original\n");
    await mkdir(join(home, "skills/react"), { recursive: true });
    await writeFile(join(home, "skills/react/SKILL.md"), "user edit\n");
    await writeFile(join(interrupted, "journal.json"), `${JSON.stringify({
      version: 1,
      phase: "prepared",
      entries: [{ name: "react", metadataOnly: false, hadSkill: true, hadMetadata: false, installedHash: "a".repeat(64) }],
    })}\n`);
    const source = await makeCollection([{ name: "playwright" }]);

    await expect(install({ source, target: { kind: "library" }, yes: true, cwd: project }))
      .rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    expect(await readFile(join(home, "skills/react/SKILL.md"), "utf8")).toBe("user edit\n");
  });

  it("preserves edited metadata from an interrupted library install", async () => {
    const interrupted = join(home, "transactions/interrupted");
    const visibleSkill = join(home, "skills/react");
    const visibleMetadata = join(home, "metadata/react.json");
    await mkdir(visibleSkill, { recursive: true });
    await writeFile(join(visibleSkill, "SKILL.md"), "installed\n");
    await mkdir(join(home, "metadata"), { recursive: true });
    await writeFile(visibleMetadata, "{\"name\":\"react\"}\n");
    const installedMetadataFingerprint = await fingerprintEntry(visibleMetadata);
    await writeFile(visibleMetadata, "user edit\n");
    await mkdir(interrupted, { recursive: true });
    await writeFile(join(interrupted, "journal.json"), `${JSON.stringify({
      version: 1,
      phase: "prepared",
      entries: [{
        name: "react",
        metadataOnly: false,
        hadSkill: false,
        hadMetadata: false,
        installedHash: await hashDirectory(visibleSkill, { includeModes: true }),
        installedMetadataFingerprint,
      }],
    })}\n`);

    await expect(install({ source: await makeCollection([{ name: "playwright" }]), target: { kind: "library" }, yes: true, cwd: project }))
      .rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    expect(await readFile(visibleMetadata, "utf8")).toBe("user edit\n");
  });

  it("reclaims an aged lock even when its PID was reused", async () => {
    const stale = join(home, `transactions/locks/install-${process.pid}-${Date.now() - 31 * 60 * 1000}-stale`);
    await mkdir(stale, { recursive: true });
    const source = await makeCollection([{ name: "react" }]);

    const result = await install({ source, target: { kind: "library" }, yes: true, cwd: project });

    expect(result.status).toBe("installed");
    expect(await pathExists(stale)).toBe(false);
  });

  it("normalizes terminal controls in discovered descriptions", async () => {
    const source = await makeCollection([{ name: "react", description: '"hello\\u001b]0;owned\\u0007 next"' }]);

    const resolved = await resolveSource(source);

    expect(resolved.skills[0]!.description).toBe("hello ]0;owned next");
  });

  it("rejects case-colliding skill names", async () => {
    const source = join(sandbox, "case-collision");
    await mkdir(join(source, "skills/first"), { recursive: true });
    await mkdir(join(source, "skills/second"), { recursive: true });
    await writeFile(join(source, "skills/first/SKILL.md"), "---\nname: React\n---\n");
    await writeFile(join(source, "skills/second/SKILL.md"), "---\nname: react\n---\n");

    await expect(install({ source, target: { kind: "library" }, yes: true, cwd: project }))
      .rejects.toMatchObject({ code: "DUPLICATE_SKILL" });
  });

  it("rejects symlinked skill collection roots", async () => {
    const source = join(sandbox, "symlinked-collection");
    const outside = await makeCollection([{ name: "react" }]);
    await mkdir(source, { recursive: true });
    await symlink(join(outside, "skills"), join(source, "skills"));

    await expect(install({ source, target: { kind: "library" }, yes: true, cwd: project }))
      .rejects.toMatchObject({ code: "INVALID_SKILL" });
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

  it("rejects symbolic links during dry-run validation", async () => {
    const source = await makeCollection([{ name: "react" }]);
    await symlink(join(sandbox, "outside"), join(source, "skills/react/linked"));

    await expect(install({ source, target: { kind: "library" }, dryRun: true, cwd: project }))
      .rejects.toThrow("Symbolic links are not supported");
  });

  it("does not overwrite concurrent environment edits during rollback", async () => {
    const source = await makeCollection([{ name: "react" }, { name: "playwright" }]);
    await install({ source, selection: { kind: "all" }, target: { kind: "environment", name: "frontend", create: true }, yes: true, cwd: project });
    const change = await putEnvironmentSkills({ name: "frontend", create: false }, ["react"]);
    await writeFile(join(home, "environments/frontend.json"), `${JSON.stringify({ version: 1, name: "frontend", skills: ["playwright"] }, null, 2)}\n`);

    await expect(change.rollback()).rejects.toMatchObject({ code: "ENVIRONMENT_CHANGED" });
    expect(JSON.parse(await readFile(join(home, "environments/frontend.json"), "utf8")).skills).toEqual(["playwright"]);
  });

  it("rejects case aliases already present in an environment", async () => {
    const source = await makeCollection([{ name: "react" }]);
    await install({ source, target: { kind: "environment", name: "frontend", create: true }, yes: true, cwd: project });

    await expect(putEnvironmentSkills({ name: "frontend", create: false }, ["React"]))
      .rejects.toMatchObject({ code: "DUPLICATE_SKILL" });
  });

  it("serializes forward environment updates", async () => {
    const source = await makeCollection([{ name: "react" }]);
    await install({ source, target: { kind: "environment", name: "frontend", create: true }, yes: true, cwd: project });
    let release!: () => void;
    let markStarted!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const first = putEnvironmentSkills({ name: "frontend", create: false }, ["react"], { beforeWrite: async () => {
      markStarted();
      await gate;
    } });
    await started;

    await expect(putEnvironmentSkills({ name: "frontend", create: false }, ["react"]))
      .rejects.toMatchObject({ code: "ENVIRONMENT_BUSY" });
    release();
    await first;
  });

  it("keeps environment readers from observing prepared library changes", async () => {
    await createEnvironment("frontend");
    const resolved = await resolveSource(await makeCollection([{ name: "react" }]));
    const change = await installLibrarySkills(resolved.skills, { input: resolved.input, kind: resolved.kind, revision: null }, { replace: false });
    try {
      await expect(addEnvironmentSkill("frontend", "react")).rejects.toMatchObject({ code: "LIBRARY_BUSY" });
    } finally {
      await change.rollback();
      await resolved.cleanup();
    }
  });
});
