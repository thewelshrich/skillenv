import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addEnvironmentSkill, createEnvironment } from "../src/environments.js";
import { pathExists } from "../src/fs.js";
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
