import { cp, mkdir, readdir, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { SkillenvError } from "./errors.js";
import { inferSkillName, pathExists } from "./fs.js";
import { libraryDir } from "./paths.js";
import { nameSchema } from "./schema.js";

export async function addSkill(sourceInput: string, options: { name?: string; force?: boolean } = {}): Promise<string> {
  const source = resolve(sourceInput);
  const name = nameSchema.parse(options.name || inferSkillName(source));
  const sourceStat = await stat(source).catch(() => null);
  if (!sourceStat?.isDirectory()) throw new SkillenvError(`Skill source is not a directory: ${sourceInput}`);
  if (!(await pathExists(join(source, "SKILL.md")))) throw new SkillenvError(`No SKILL.md found in ${sourceInput}`);

  const destination = join(libraryDir(), name);
  if (await pathExists(destination)) {
    if (!options.force) throw new SkillenvError(`Skill '${name}' already exists (use --force to replace it)`);
    await rm(destination, { recursive: true });
  }
  await mkdir(libraryDir(), { recursive: true });
  await cp(source, destination, { recursive: true, errorOnExist: true, force: false });
  return name;
}

export async function listSkills(): Promise<string[]> {
  const entries = await readdir(libraryDir(), { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
}

export async function requireSkill(nameInput: string): Promise<string> {
  const name = nameSchema.parse(nameInput);
  const path = join(libraryDir(), name);
  if (!(await pathExists(path))) throw new SkillenvError(`Unknown skill '${name}'`);
  return path;
}
