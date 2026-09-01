import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { SkillenvError } from "./errors.js";
import { pathExists, readJson, writeJson } from "./fs.js";
import { requireSkill } from "./library.js";
import { environmentsDir } from "./paths.js";
import { environmentSchema, nameSchema, type Environment } from "./schema.js";

function environmentPath(name: string): string {
  return join(environmentsDir(), `${name}.json`);
}

export async function createEnvironment(nameInput: string): Promise<Environment> {
  const name = nameSchema.parse(nameInput);
  const path = environmentPath(name);
  if (await pathExists(path)) throw new SkillenvError(`Environment '${name}' already exists`);
  const environment: Environment = { version: 1, name, skills: [] };
  await mkdir(environmentsDir(), { recursive: true });
  await writeJson(path, environment);
  return environment;
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
  const environment = await readEnvironment(environmentName);
  if (!environment.skills.includes(skillName)) {
    environment.skills.push(skillName);
    environment.skills.sort();
    await writeJson(environmentPath(environment.name), environment);
  }
  return environment;
}

export async function removeEnvironmentSkill(environmentName: string, skillNameInput: string): Promise<Environment> {
  const skillName = nameSchema.parse(skillNameInput);
  const environment = await readEnvironment(environmentName);
  if (!environment.skills.includes(skillName)) throw new SkillenvError(`Skill '${skillName}' is not in environment '${environment.name}'`);
  environment.skills = environment.skills.filter((skill) => skill !== skillName);
  await writeJson(environmentPath(environment.name), environment);
  return environment;
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
  if (!(await pathExists(environmentPath(name)))) throw new SkillenvError(`Unknown environment '${name}'`);
  await rm(environmentPath(name));
}
