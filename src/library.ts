import { randomUUID } from "node:crypto";
import { cp, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { SkillenvError } from "./errors.js";
import { copySkillDirectory, hashDirectory, inferSkillName, pathExists, writeJson } from "./fs.js";
import { libraryDir, metadataDir, transactionsDir } from "./paths.js";
import { nameSchema, type SkillMetadata } from "./schema.js";

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

export interface PreparedSkill {
  name: string;
  description: string;
  directory: string;
  sourcePath: string;
}

export interface LibraryInspection {
  conflicts: string[];
  unchanged: string[];
}

export async function inspectLibrary(skills: readonly PreparedSkill[]): Promise<LibraryInspection> {
  const conflicts: string[] = [];
  const unchanged: string[] = [];
  for (const skill of skills) {
    const destination = join(libraryDir(), skill.name);
    if (!(await pathExists(destination))) continue;
    const [existingHash, candidateHash] = await Promise.all([
      hashDirectory(destination),
      hashDirectory(skill.directory, { ignoreNames: new Set([".git"]) }),
    ]);
    if (existingHash === candidateHash) unchanged.push(skill.name);
    else conflicts.push(skill.name);
  }
  return { conflicts, unchanged };
}

export interface LibraryChange {
  installed: string[];
  replaced: string[];
  unchanged: string[];
  rollback(): Promise<void>;
  finalize(): Promise<void>;
}

export async function installLibrarySkills(
  skills: readonly PreparedSkill[],
  source: { input: string; kind: "local" | "git"; revision: string | null },
  options: { replace: boolean },
): Promise<LibraryChange> {
  const inspection = await inspectLibrary(skills);
  if (inspection.conflicts.length && !options.replace) {
    throw new SkillenvError(`Library conflicts: ${inspection.conflicts.join(", ")}`, "LIBRARY_CONFLICT");
  }

  const transactionRoot = join(transactionsDir(), randomUUID());
  const stagedSkills = join(transactionRoot, "staged", "skills");
  const stagedMetadata = join(transactionRoot, "staged", "metadata");
  const backupSkills = join(transactionRoot, "backup", "skills");
  const backupMetadata = join(transactionRoot, "backup", "metadata");
  const unchanged = new Set(inspection.unchanged);
  const installed = skills.filter((skill) => !unchanged.has(skill.name)).map((skill) => skill.name);
  const replaced = inspection.conflicts;

  try {
    for (const skill of skills) await hashDirectory(skill.directory, { ignoreNames: new Set([".git"]) });
    await mkdir(stagedSkills, { recursive: true });
    await mkdir(stagedMetadata, { recursive: true });
    for (const skill of skills.filter((candidate) => !unchanged.has(candidate.name))) {
      const stagedSkill = join(stagedSkills, skill.name);
      await copySkillDirectory(skill.directory, stagedSkill);
      const metadata: SkillMetadata = {
        version: 1,
        name: skill.name,
        description: skill.description,
        source: source.input,
        sourceKind: source.kind,
        sourcePath: skill.sourcePath,
        revision: source.revision,
        hash: await hashDirectory(stagedSkill),
        installedAt: new Date().toISOString(),
      };
      await writeJson(join(stagedMetadata, `${skill.name}.json`), metadata);
    }
  } catch (error) {
    await rm(transactionRoot, { recursive: true, force: true });
    throw error;
  }

  const committed: string[] = [];
  async function rollback(): Promise<void> {
    for (const name of [...committed].reverse()) {
      await rm(join(libraryDir(), name), { recursive: true, force: true });
      await rm(join(metadataDir(), `${name}.json`), { force: true });
      if (await pathExists(join(backupSkills, name))) {
        await mkdir(libraryDir(), { recursive: true });
        await rename(join(backupSkills, name), join(libraryDir(), name));
      }
      if (await pathExists(join(backupMetadata, `${name}.json`))) {
        await mkdir(metadataDir(), { recursive: true });
        await rename(join(backupMetadata, `${name}.json`), join(metadataDir(), `${name}.json`));
      }
    }
    await rm(transactionRoot, { recursive: true, force: true });
  }

  try {
    await mkdir(libraryDir(), { recursive: true });
    await mkdir(metadataDir(), { recursive: true });
    for (const name of installed) {
      const destination = join(libraryDir(), name);
      const metadataDestination = join(metadataDir(), `${name}.json`);
      if (await pathExists(destination)) {
        await mkdir(backupSkills, { recursive: true });
        await rename(destination, join(backupSkills, name));
      }
      if (await pathExists(metadataDestination)) {
        await mkdir(backupMetadata, { recursive: true });
        await rename(metadataDestination, join(backupMetadata, `${name}.json`));
      }
      committed.push(name);
      await rename(join(stagedSkills, name), destination);
      await rename(join(stagedMetadata, `${name}.json`), metadataDestination);
    }
  } catch (error) {
    await rollback();
    throw error;
  }

  return {
    installed,
    replaced,
    unchanged: inspection.unchanged,
    rollback,
    finalize: () => rm(transactionRoot, { recursive: true, force: true }),
  };
}
