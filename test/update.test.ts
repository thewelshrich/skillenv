import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEnvironment } from "../src/environments.js";
import { addSkill } from "../src/library.js";
import { install } from "../src/install.js";
import { update } from "../src/update.js";

const execFileAsync = promisify(execFile);

describe("update", () => {
  let sandbox: string;
  let home: string;
  let project: string;
  let repository: string;

  beforeEach(async () => {
    sandbox = await mkdtemp(join(tmpdir(), "skillenv-update-"));
    home = join(sandbox, "home");
    project = join(sandbox, "project");
    repository = join(sandbox, "remote");
    process.env.SKILLENV_HOME = home;
    await mkdir(project, { recursive: true });
    await execFileAsync("git", ["init", "-q", project]);
    await execFileAsync("git", ["init", "-q", repository]);
    await execFileAsync("git", ["-C", repository, "config", "user.name", "Test"]);
    await execFileAsync("git", ["-C", repository, "config", "user.email", "test@example.com"]);
  });

  afterEach(async () => {
    delete process.env.SKILLENV_HOME;
    await rm(sandbox, { recursive: true, force: true });
  });

  async function writeSkill(root: string, name: string, body: string): Promise<void> {
    await mkdir(join(root, "skills", name), { recursive: true });
    await writeFile(join(root, "skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} description\n---\n\n${body}\n`);
  }

  async function commit(message: string): Promise<string> {
    await execFileAsync("git", ["-C", repository, "add", "-A"]);
    await execFileAsync("git", ["-C", repository, "commit", "-qm", message]);
    const { stdout } = await execFileAsync("git", ["-C", repository, "rev-parse", "HEAD"], { encoding: "utf8" });
    return stdout.trim();
  }

  async function installFrom(source: string, target: { kind: "library" } | { kind: "environment"; name: string; create: boolean } = { kind: "library" }, cwd = project): Promise<void> {
    await install({ source, selection: { kind: "all" }, target, yes: true, cwd });
  }

  const librarySkill = (name: string) => readFile(join(home, "skills", name, "SKILL.md"), "utf8");
  const metadata = async (name: string) => JSON.parse(await readFile(join(home, "metadata", `${name}.json`), "utf8"));

  it("updates Git skills to the latest revision of their recorded source", async () => {
    await writeSkill(repository, "react", "# v1");
    await writeSkill(repository, "playwright", "# v1");
    const first = await commit("v1");
    await installFrom(`file://${repository}`, { kind: "environment", name: "frontend", create: true });
    await writeSkill(repository, "react", "# v2");
    const second = await commit("v2");

    const result = await update();

    expect(result.skills).toEqual([
      { name: "playwright", status: "current" },
      { name: "react", status: "updated", from: first, to: second },
    ]);
    expect(result.environments).toEqual(["frontend"]);
    expect(await librarySkill("react")).toContain("# v2");
    expect((await metadata("react")).revision).toBe(second);
    expect((await metadata("playwright")).revision).toBe(second);
    expect((await update()).skills.every((skill) => skill.status === "current")).toBe(true);
  });

  it("previews changes without writing during a dry run", async () => {
    await writeSkill(repository, "react", "# v1");
    const first = await commit("v1");
    await installFrom(`file://${repository}`);
    await writeSkill(repository, "react", "# v2");
    await commit("v2");

    const result = await update({ dryRun: true });

    expect(result.skills[0]).toMatchObject({ name: "react", status: "updated" });
    expect(await librarySkill("react")).toContain("# v1");
    expect((await metadata("react")).revision).toBe(first);
  });

  it("refuses to overwrite library edits unless forced", async () => {
    await writeSkill(repository, "react", "# v1");
    await commit("v1");
    await installFrom(`file://${repository}`);
    await writeFile(join(home, "skills/react/SKILL.md"), "# my edits\n");
    await writeSkill(repository, "react", "# v2");
    await commit("v2");

    const skipped = await update();
    expect(skipped.skills[0]).toMatchObject({ name: "react", status: "skipped" });
    expect(await librarySkill("react")).toBe("# my edits\n");

    const forced = await update({ force: true });
    expect(forced.skills[0]).toMatchObject({ name: "react", status: "updated" });
    expect(await librarySkill("react")).toContain("# v2");
  });

  it("updates the remaining skills when one disappears from its source", async () => {
    await writeSkill(repository, "react", "# v1");
    await writeSkill(repository, "legacy", "# v1");
    await commit("v1");
    await installFrom(`file://${repository}`);
    await rm(join(repository, "skills/legacy"), { recursive: true });
    await writeSkill(repository, "react", "# v2");
    await commit("v2");

    const result = await update();

    expect(result.skills).toEqual([
      expect.objectContaining({ name: "legacy", status: "failed", reason: expect.stringContaining("no longer found at skills/legacy") }),
      expect.objectContaining({ name: "react", status: "updated" }),
    ]);
    expect(await librarySkill("legacy")).toContain("# v1");
    expect(await librarySkill("react")).toContain("# v2");
  });

  it("updates only the named skills", async () => {
    await writeSkill(repository, "react", "# v1");
    await writeSkill(repository, "playwright", "# v1");
    await commit("v1");
    await installFrom(`file://${repository}`);
    await writeSkill(repository, "react", "# v2");
    await writeSkill(repository, "playwright", "# v2");
    await commit("v2");

    const result = await update({ skills: ["react"] });

    expect(result.skills).toEqual([expect.objectContaining({ name: "react", status: "updated" })]);
    expect(await librarySkill("playwright")).toContain("# v1");
    await expect(update({ skills: ["missing"] })).rejects.toThrow("Unknown skill 'missing'");
  });

  it("updates local sources installed through a relative path from any directory", async () => {
    const local = join(sandbox, "local");
    await writeSkill(local, "notes", "# v1");
    await installFrom(relative(process.cwd(), local));
    expect((await metadata("notes")).source).toBe(local);
    await writeSkill(local, "notes", "# v2");

    const result = await update();

    expect(result.skills).toEqual([{ name: "notes", status: "updated", from: null, to: null }]);
    expect(await librarySkill("notes")).toContain("# v2");
  });

  it("skips skills without recorded provenance", async () => {
    const legacy = join(sandbox, "legacy");
    await mkdir(legacy, { recursive: true });
    await writeFile(join(legacy, "SKILL.md"), "# legacy\n");
    await addSkill(legacy);
    await createEnvironment("unused");

    const result = await update();

    expect(result.skills).toEqual([expect.objectContaining({ name: "legacy", status: "skipped", reason: expect.stringContaining("no recorded source") })]);
    expect(result.environments).toEqual([]);
  });
});
