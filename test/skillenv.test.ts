import { execFile } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addEnvironmentSkill, createEnvironment } from "../src/environments.js";
import { hashDirectory, pathExists } from "../src/fs.js";
import { addSkill, listSkills } from "../src/library.js";
import { activate, deactivate, getStatus } from "../src/materialize.js";

const execFileAsync = promisify(execFile);

describe("skillenv", () => {
  let sandbox: string;
  let home: string;
  let project: string;

  beforeEach(async () => {
    sandbox = await mkdtemp(join(tmpdir(), "skillenv-test-"));
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

  async function makeSkill(name: string, body = `# ${name}\n`): Promise<string> {
    const source = join(sandbox, "sources", name);
    await mkdir(join(source, "references"), { recursive: true });
    await writeFile(join(source, "SKILL.md"), body);
    await writeFile(join(source, "references", "notes.md"), `${name} notes\n`);
    return source;
  }

  async function addEnvironment(name: string, skills: string[]): Promise<void> {
    await createEnvironment(name);
    for (const skill of skills) await addEnvironmentSkill(name, skill);
  }

  it("adds local skills and materialises an environment for standard and Claude paths", async () => {
    await addSkill(await makeSkill("react"));
    await addEnvironment("frontend", ["react"]);

    const result = await activate("frontend", project);

    expect(await listSkills()).toEqual(["react"]);
    expect(result.state.environment).toBe("frontend");
    expect(await readFile(join(project, ".agents/skills/react/SKILL.md"), "utf8")).toBe("# react\n");
    expect(await readFile(join(project, ".claude/skills/react/SKILL.md"), "utf8")).toBe("# react\n");
    const exclude = await readFile(join(project, ".git/info/exclude"), "utf8");
    expect(exclude).toContain("# >>> skillenv");
    expect(exclude).toContain("/.agents/skills/react/");
    expect(exclude).toContain("/.claude/skills/react/");
    expect(exclude).toContain("/.skillenv/");
  });

  it("switches environments while leaving unrelated project skills untouched", async () => {
    await addSkill(await makeSkill("react"));
    await addSkill(await makeSkill("python"));
    await addEnvironment("frontend", ["react"]);
    await addEnvironment("backend", ["python"]);
    const teamSkill = join(project, ".agents/skills/company-deploy");
    await mkdir(teamSkill, { recursive: true });
    await writeFile(join(teamSkill, "SKILL.md"), "team owned\n");

    await activate("frontend", project);
    await activate("backend", project);

    expect(await pathExists(join(project, ".agents/skills/react"))).toBe(false);
    expect(await pathExists(join(project, ".claude/skills/react"))).toBe(false);
    expect(await pathExists(join(project, ".agents/skills/python"))).toBe(true);
    expect(await readFile(join(teamSkill, "SKILL.md"), "utf8")).toBe("team owned\n");
  });

  it("refuses to overwrite an unmanaged skill with the same name", async () => {
    await addSkill(await makeSkill("react"));
    await addEnvironment("frontend", ["react"]);
    const existing = join(project, ".agents/skills/react");
    await mkdir(existing, { recursive: true });
    await writeFile(join(existing, "SKILL.md"), "project owned\n");

    await expect(activate("frontend", project)).rejects.toThrow("Refusing to overwrite unmanaged skill");
    expect(await readFile(join(existing, "SKILL.md"), "utf8")).toBe("project owned\n");
    expect(await pathExists(join(project, ".skillenv/state.json"))).toBe(false);
  });

  it("rolls back project files when activation fails before state is written", async () => {
    await addSkill(await makeSkill("react"));
    await addEnvironment("frontend", ["react"]);
    await mkdir(join(project, ".claude"), { recursive: true });
    await symlink(join(project, "missing-skills-root"), join(project, ".claude/skills"));

    await expect(activate("frontend", project)).rejects.toThrow();

    expect(await pathExists(join(project, ".agents/skills/react"))).toBe(false);
    expect(await pathExists(join(project, ".skillenv/state.json"))).toBe(false);
    expect(await pathExists(join(home, "skills/react/SKILL.md"))).toBe(true);
  });

  it("refuses to materialize through symlinked destination ancestors", async () => {
    await addSkill(await makeSkill("react"));
    await addEnvironment("frontend", ["react"]);
    const outside = join(sandbox, "outside-skills");
    await mkdir(outside, { recursive: true });
    await mkdir(join(project, ".agents"), { recursive: true });
    await symlink(outside, join(project, ".agents/skills"));

    await expect(activate("frontend", project)).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    expect(await pathExists(join(outside, "react"))).toBe(false);
    expect(await pathExists(join(project, ".skillenv/state.json"))).toBe(false);
  });

  it("recovers an activation interrupted during backup moves", async () => {
    await addSkill(await makeSkill("react"));
    await addEnvironment("frontend", ["react"]);
    await activate("frontend", project);
    const previous = JSON.parse(await readFile(join(project, ".skillenv/state.json"), "utf8"));
    const transaction = join(project, ".skillenv/staging-interrupted");
    for (const path of [".agents/skills/react", ".claude/skills/react"]) {
      await mkdir(join(transaction, "next", path, ".."), { recursive: true });
      await cp(join(home, "skills/react"), join(transaction, "next", path), { recursive: true });
    }
    await mkdir(join(transaction, "backup/.agents/skills"), { recursive: true });
    await rename(join(project, ".agents/skills/react"), join(transaction, "backup/.agents/skills/react"));
    await writeFile(join(transaction, "journal.json"), `${JSON.stringify({
      version: 1,
      phase: "prepared",
      previous,
      planned: [
        { skill: "react", path: ".agents/skills/react", hash: previous.managed.find((entry: { path: string }) => entry.path === ".agents/skills/react").hash },
        { skill: "react", path: ".claude/skills/react", hash: previous.managed.find((entry: { path: string }) => entry.path === ".claude/skills/react").hash },
      ],
    })}\n`);

    const status = await getStatus(project);

    expect(status.state?.environment).toBe("frontend");
    expect(status.drifted).toEqual([]);
    expect(await pathExists(join(project, ".agents/skills/react/SKILL.md"))).toBe(true);
    expect(await pathExists(transaction)).toBe(false);
  });

  it("preserves edits to a path from an interrupted activation", async () => {
    await addSkill(await makeSkill("react"));
    await addEnvironment("frontend", ["react"]);
    const transaction = join(project, ".skillenv/staging-interrupted");
    const destination = join(project, ".agents/skills/react");
    await mkdir(destination, { recursive: true });
    await writeFile(join(destination, "SKILL.md"), "user edit\n");
    await mkdir(transaction, { recursive: true });
    await writeFile(join(transaction, "journal.json"), `${JSON.stringify({
      version: 1,
      phase: "prepared",
      previous: null,
      planned: [{ skill: "react", path: ".agents/skills/react", hash: "a".repeat(64) }],
    })}\n`);

    await expect(getStatus(project)).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    expect(await readFile(join(destination, "SKILL.md"), "utf8")).toBe("user edit\n");
  });

  it("refuses recovery through symlinked managed-path ancestors", async () => {
    const outside = join(sandbox, "outside");
    const externalSkill = join(outside, "react");
    await mkdir(externalSkill, { recursive: true });
    await writeFile(join(externalSkill, "SKILL.md"), "external\n");
    await mkdir(join(project, ".agents"), { recursive: true });
    await symlink(outside, join(project, ".agents/skills"));
    const transaction = join(project, ".skillenv/staging-interrupted");
    await mkdir(transaction, { recursive: true });
    await writeFile(join(transaction, "journal.json"), `${JSON.stringify({
      version: 1,
      phase: "prepared",
      previous: null,
      planned: [{ skill: "react", path: ".agents/skills/react", hash: await hashDirectory(externalSkill) }],
    })}\n`);

    await expect(getStatus(project)).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    expect(await readFile(join(externalSkill, "SKILL.md"), "utf8")).toBe("external\n");
  });

  it("refuses symlinked project metadata roots without deleting external transactions", async () => {
    const outsideMetadata = join(sandbox, "outside-metadata");
    const externalTransaction = join(outsideMetadata, "staging-external");
    await mkdir(externalTransaction, { recursive: true });
    await writeFile(join(externalTransaction, "keep.txt"), "external\n");
    await symlink(outsideMetadata, join(project, ".skillenv"));

    await expect(getStatus(project)).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    expect(await readFile(join(externalTransaction, "keep.txt"), "utf8")).toBe("external\n");
  });

  it("preserves modified newly installed paths during activation rollback", async () => {
    await addSkill(await makeSkill("react"));
    await addEnvironment("frontend", ["react"]);
    const gitExclude = join(project, ".git/info/exclude");
    await rm(gitExclude);
    await mkdir(gitExclude);
    const destination = join(project, ".agents/skills/react");
    const editWhenInstalled = (async () => {
      for (let attempt = 0; attempt < 5000; attempt += 1) {
        if (await pathExists(destination)) {
          await writeFile(join(destination, "SKILL.md"), "user edit\n");
          return;
        }
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      throw new Error("Activation did not materialize the expected path");
    })();

    await expect(activate("frontend", project)).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    await editWhenInstalled;
    expect(await readFile(join(destination, "SKILL.md"), "utf8")).toBe("user edit\n");
  });

  it("reads inactive status without creating project state", async () => {
    const status = await getStatus(project);

    expect(status.state).toBeNull();
    expect(await pathExists(join(project, ".skillenv"))).toBe(false);
  });

  it("refuses to delete a managed copy that was modified", async () => {
    await addSkill(await makeSkill("react"));
    await addEnvironment("frontend", ["react"]);
    await activate("frontend", project);
    const managedFile = join(project, ".agents/skills/react/SKILL.md");
    await writeFile(managedFile, "locally edited\n");

    const status = await getStatus(project);
    expect(status.drifted).toEqual([".agents/skills/react"]);
    await expect(deactivate(project)).rejects.toThrow("Managed skill was modified");
    expect(await readFile(managedFile, "utf8")).toBe("locally edited\n");
  });

  it("deactivates cleanly and preserves non-Skillenv ignore rules", async () => {
    await writeFile(join(project, ".git/info/exclude"), "*.local\n");
    await addSkill(await makeSkill("react"));
    await addEnvironment("frontend", ["react"]);
    await activate("frontend", project);

    const result = await deactivate(project);

    expect(result.environment).toBe("frontend");
    expect(await pathExists(join(project, ".agents/skills/react"))).toBe(false);
    expect(await pathExists(join(project, ".claude/skills/react"))).toBe(false);
    expect(await pathExists(join(project, ".skillenv/state.json"))).toBe(false);
    expect(await readFile(join(project, ".git/info/exclude"), "utf8")).toBe("*.local\n");
  });
});
