import { randomUUID } from "node:crypto";
import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { SkillenvError } from "./errors.js";
import { pathExists, readJson, writeJson } from "./fs.js";
import { requireSkill } from "./library.js";
import { environmentsDir, skillenvHome } from "./paths.js";
import { environmentSchema, nameSchema, type Environment } from "./schema.js";

function environmentPath(name: string): string {
  return join(environmentsDir(), `${name}.json`);
}

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

const LOCK_STALE_MS = 30 * 60 * 1000;

export async function withEnvironmentLock<T>(operation: () => Promise<T>): Promise<T> {
  const lockRoot = join(skillenvHome(), "environment-locks");
  await mkdir(lockRoot, { recursive: true });
  const name = `environment-${process.pid}-${Date.now()}-${randomUUID()}`;
  const owned = join(lockRoot, name);
  await mkdir(owned);
  try {
    const contenders = await readdir(lockRoot, { withFileTypes: true });
    let active = false;
    for (const contender of contenders.filter((entry) => entry.isDirectory() && entry.name !== name)) {
      const match = /^environment-(\d+)-(\d+)-/.exec(contender.name);
      const pid = Number(match?.[1]);
      const createdAt = Number(match?.[2]);
      if (Number.isInteger(pid) && pid > 0 && processIsRunning(pid) && Number.isFinite(createdAt) && Date.now() - createdAt < LOCK_STALE_MS) active = true;
      else await rm(join(lockRoot, contender.name), { recursive: true, force: true });
    }
    if (active) throw new SkillenvError("Another Skillenv operation is updating environments", "ENVIRONMENT_BUSY");
    return await operation();
  } finally {
    await rm(owned, { recursive: true, force: true }).catch(() => {});
  }
}

function assertNoCaseCollisions(skills: readonly string[]): void {
  const seen = new Map<string, string>();
  for (const skill of skills) {
    const key = skill.toLocaleLowerCase("en-US");
    const existing = seen.get(key);
    if (existing && existing !== skill) throw new SkillenvError(`Skill names '${existing}' and '${skill}' collide on case-insensitive filesystems`, "DUPLICATE_SKILL");
    seen.set(key, skill);
  }
}

export async function environmentExists(nameInput: string): Promise<boolean> {
  return pathExists(environmentPath(nameSchema.parse(nameInput)));
}

export async function createEnvironment(nameInput: string): Promise<Environment> {
  const name = nameSchema.parse(nameInput);
  return withEnvironmentLock(async () => {
    const path = environmentPath(name);
    if (await pathExists(path)) throw new SkillenvError(`Environment '${name}' already exists`);
    const environment: Environment = { version: 1, name, skills: [] };
    await mkdir(environmentsDir(), { recursive: true });
    await writeJson(path, environment);
    return environment;
  });
}

export async function readEnvironment(nameInput: string): Promise<Environment> {
  const name = nameSchema.parse(nameInput);
  const path = environmentPath(name);
  if (!(await pathExists(path))) throw new SkillenvError(`Unknown environment '${name}'`);
  return environmentSchema.parse(await readJson(path));
}

export async function addEnvironmentSkill(environmentName: string, skillNameInput: string): Promise<Environment> {
  const skillName = nameSchema.parse(skillNameInput);
  await requireSkill(skillName);
  return withEnvironmentLock(async () => {
    const environment = await readEnvironment(environmentName);
    if (!environment.skills.includes(skillName)) {
      environment.skills.push(skillName);
      assertNoCaseCollisions(environment.skills);
      environment.skills.sort();
      await writeJson(environmentPath(environment.name), environment);
    }
    return environment;
  });
}

export async function removeEnvironmentSkill(environmentName: string, skillNameInput: string): Promise<Environment> {
  const skillName = nameSchema.parse(skillNameInput);
  return withEnvironmentLock(async () => {
    const environment = await readEnvironment(environmentName);
    if (!environment.skills.includes(skillName)) throw new SkillenvError(`Skill '${skillName}' is not in environment '${environment.name}'`);
    environment.skills = environment.skills.filter((skill) => skill !== skillName);
    await writeJson(environmentPath(environment.name), environment);
    return environment;
  });
}

export async function listEnvironments(): Promise<Environment[]> {
  const entries = await readdir(environmentsDir(), { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  return Promise.all(entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json")).sort((a, b) => a.name.localeCompare(b.name)).map((entry) => readEnvironment(entry.name.slice(0, -5))));
}

export async function deleteEnvironment(nameInput: string): Promise<void> {
  const name = nameSchema.parse(nameInput);
  await withEnvironmentLock(async () => {
    if (!(await pathExists(environmentPath(name)))) throw new SkillenvError(`Unknown environment '${name}'`);
    await rm(environmentPath(name));
  });
}

export interface EnvironmentChange {
  environment: Environment;
  created: boolean;
  rollback(): Promise<void>;
}

export async function putEnvironmentSkills(
  target: { name: string; create: boolean },
  skills: readonly string[],
  options: { beforeWrite?: (previous: Environment | null, next: Environment) => Promise<void> } = {},
): Promise<EnvironmentChange> {
  const name = nameSchema.parse(target.name);
  let previous: Environment | null = null;
  let environment!: Environment;
  await withEnvironmentLock(async () => {
    const exists = await pathExists(environmentPath(name));
    if (target.create && exists) throw new SkillenvError(`Environment '${name}' already exists`);
    if (!target.create && !exists) throw new SkillenvError(`Unknown environment '${name}'`);
    previous = exists ? await readEnvironment(name) : null;
    environment = { version: 1, name, skills: [...new Set([...(previous?.skills ?? []), ...skills])].sort() };
    assertNoCaseCollisions(environment.skills);
    await options.beforeWrite?.(previous, environment);
    await writeJson(environmentPath(name), environment);
  });
  return {
    environment,
    created: !previous,
    rollback: async () => {
      await withEnvironmentLock(async () => {
        const current = await readEnvironment(name);
        if (JSON.stringify(current) !== JSON.stringify(environment)) {
          throw new SkillenvError(`Environment '${name}' changed concurrently; refusing to overwrite it`, "ENVIRONMENT_CHANGED");
        }
        if (previous) await writeJson(environmentPath(name), previous);
        else await rm(environmentPath(name), { force: true });
      });
    },
  };
}
