import { randomUUID } from "node:crypto";
import { cp, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { SkillenvError } from "./errors.js";
import { copySkillDirectory, hashDirectory, inferSkillName, pathExists, writeJson } from "./fs.js";
import { libraryDir, metadataDir, transactionsDir } from "./paths.js";
import { nameSchema, type SkillMetadata } from "./schema.js";
import { sanitizeSourceInput } from "./sources.js";

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
    const candidateHash = await hashDirectory(skill.directory, { ignoreNames: new Set([".git"]) });
    const existingHash = await hashDirectory(destination).catch(() => null);
    if (existingHash === null) {
      conflicts.push(skill.name);
      continue;
    }
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
  const metadataOnly = new Set<string>();
  for (const skill of skills.filter((candidate) => unchanged.has(candidate.name))) {
    if (!(await pathExists(join(metadataDir(), `${skill.name}.json`)))) metadataOnly.add(skill.name);
  }
  const metadataNames = new Set([...installed, ...metadataOnly]);

  try {
    for (const skill of skills) await hashDirectory(skill.directory, { ignoreNames: new Set([".git"]) });
    await mkdir(stagedSkills, { recursive: true });
    await mkdir(stagedMetadata, { recursive: true });
    for (const skill of skills.filter((candidate) => metadataNames.has(candidate.name))) {
      const stagedSkill = join(stagedSkills, skill.name);
      if (!metadataOnly.has(skill.name)) await copySkillDirectory(skill.directory, stagedSkill);
      const metadata: SkillMetadata = {
        version: 1,
        name: skill.name,
        description: skill.description,
        source: sanitizeSourceInput(source.input),
        sourceKind: source.kind,
        sourcePath: skill.sourcePath,
        revision: source.revision,
        hash: await hashDirectory(metadataOnly.has(skill.name) ? skill.directory : stagedSkill, metadataOnly.has(skill.name) ? { ignoreNames: new Set([".git"]) } : undefined),
        installedAt: new Date().toISOString(),
      };
      await writeJson(join(stagedMetadata, `${skill.name}.json`), metadata);
    }
  } catch (error) {
    await rm(transactionRoot, { recursive: true, force: true });
    throw error;
  }

  interface CommitRecord {
    name: string;
    skillBackedUp: boolean;
    metadataBackedUp: boolean;
    skillInstalled: boolean;
    metadataInstalled: boolean;
  }
  const committed: CommitRecord[] = [];
  async function rollback(): Promise<void> {
    for (const record of [...committed].reverse()) {
      const { name } = record;
      if (record.skillInstalled) await rm(join(libraryDir(), name), { recursive: true, force: true });
      if (record.metadataInstalled) await rm(join(metadataDir(), `${name}.json`), { force: true });
      if (record.skillBackedUp) {
        await mkdir(libraryDir(), { recursive: true });
        await rename(join(backupSkills, name), join(libraryDir(), name));
      }
      if (record.metadataBackedUp) {
        await mkdir(metadataDir(), { recursive: true });
        await rename(join(backupMetadata, `${name}.json`), join(metadataDir(), `${name}.json`));
      }
    }
    await rm(transactionRoot, { recursive: true, force: true });
  }

  try {
    await mkdir(libraryDir(), { recursive: true });
    await mkdir(metadataDir(), { recursive: true });
    for (const name of metadataNames) {
      const destination = join(libraryDir(), name);
      const metadataDestination = join(metadataDir(), `${name}.json`);
      const record: CommitRecord = { name, skillBackedUp: false, metadataBackedUp: false, skillInstalled: false, metadataInstalled: false };
      committed.push(record);
      if (!metadataOnly.has(name) && await pathExists(destination)) {
        await mkdir(backupSkills, { recursive: true });
        await rename(destination, join(backupSkills, name));
        record.skillBackedUp = true;
      }
      if (await pathExists(metadataDestination)) {
        await mkdir(backupMetadata, { recursive: true });
        await rename(metadataDestination, join(backupMetadata, `${name}.json`));
        record.metadataBackedUp = true;
      }
      if (!metadataOnly.has(name)) {
        await rename(join(stagedSkills, name), destination);
        record.skillInstalled = true;
      }
      await rename(join(stagedMetadata, `${name}.json`), metadataDestination);
      record.metadataInstalled = true;
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
