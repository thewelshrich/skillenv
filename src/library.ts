import { randomUUID } from "node:crypto";
import { cp, mkdir, open, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { SkillenvError } from "./errors.js";
import { copySkillDirectory, hashDirectory, inferSkillName, pathExists, readJson, writeJson } from "./fs.js";
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

interface TransactionEntry {
  name: string;
  metadataOnly: boolean;
  hadSkill: boolean;
  hadMetadata: boolean;
}

interface TransactionJournal {
  version: 1;
  phase: "prepared" | "committed";
  entries: TransactionEntry[];
}

function transactionJournal(value: unknown): TransactionJournal | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<TransactionJournal>;
  if (candidate.version !== 1 || (candidate.phase !== "prepared" && candidate.phase !== "committed") || !Array.isArray(candidate.entries)) return null;
  const entries: TransactionEntry[] = [];
  for (const entry of candidate.entries) {
    if (!entry || typeof entry !== "object") return null;
    const item = entry as Partial<TransactionEntry>;
    const parsedName = nameSchema.safeParse(item.name);
    if (!parsedName.success || typeof item.metadataOnly !== "boolean" || typeof item.hadSkill !== "boolean" || typeof item.hadMetadata !== "boolean") return null;
    entries.push({ name: parsedName.data, metadataOnly: item.metadataOnly, hadSkill: item.hadSkill, hadMetadata: item.hadMetadata });
  }
  return { version: 1, phase: candidate.phase, entries };
}

const lockPath = () => join(transactionsDir(), "install.lock");

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function acquireLibraryLock(retry = true): Promise<() => Promise<void>> {
  await mkdir(transactionsDir(), { recursive: true });
  let created = false;
  try {
    const handle = await open(lockPath(), "wx");
    created = true;
    try {
      await handle.writeFile(`${process.pid}\n`);
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (created) await rm(lockPath(), { force: true });
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const owner = Number(await readFile(lockPath(), "utf8").catch(() => ""));
    if (retry && Number.isInteger(owner) && owner > 0 && !processIsRunning(owner)) {
      await rm(lockPath(), { force: true });
      return acquireLibraryLock(false);
    }
    throw new SkillenvError("Another skill installation is already updating the library", "LIBRARY_BUSY");
  }
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    await rm(lockPath(), { force: true });
  };
}

async function recoverLibraryTransactions(): Promise<void> {
  const entries = await readdir(transactionsDir(), { withFileTypes: true }).catch(() => []);
  for (const entry of entries.filter((candidate) => candidate.isDirectory())) {
    const root = join(transactionsDir(), entry.name);
    const journal = transactionJournal(await readJson(join(root, "journal.json")).catch(() => null));
    const backupSkills = join(root, "backup", "skills");
    const backupMetadata = join(root, "backup", "metadata");
    if (journal?.version === 1 && journal.phase === "prepared") {
      for (const item of [...journal.entries].reverse()) {
        const destination = join(libraryDir(), item.name);
        const metadataDestination = join(metadataDir(), `${item.name}.json`);
        const skillBackup = join(backupSkills, item.name);
        const metadataBackup = join(backupMetadata, `${item.name}.json`);
        if (!item.metadataOnly) {
          if (await pathExists(skillBackup)) {
            await rm(destination, { recursive: true, force: true });
            await mkdir(libraryDir(), { recursive: true });
            await rename(skillBackup, destination);
          } else if (!item.hadSkill) {
            await rm(destination, { recursive: true, force: true });
          }
        }
        if (await pathExists(metadataBackup)) {
          await rm(metadataDestination, { force: true });
          await mkdir(metadataDir(), { recursive: true });
          await rename(metadataBackup, metadataDestination);
        } else if (!item.hadMetadata) {
          await rm(metadataDestination, { force: true });
        }
      }
    } else if (!journal) {
      for (const backup of await readdir(backupSkills, { withFileTypes: true }).catch(() => [])) {
        const destination = join(libraryDir(), backup.name);
        if (!(await pathExists(destination))) {
          await mkdir(libraryDir(), { recursive: true });
          await rename(join(backupSkills, backup.name), destination);
        }
      }
      for (const backup of await readdir(backupMetadata, { withFileTypes: true }).catch(() => [])) {
        const destination = join(metadataDir(), backup.name);
        if (!(await pathExists(destination))) {
          await mkdir(metadataDir(), { recursive: true });
          await rename(join(backupMetadata, backup.name), destination);
        }
      }
    }
    await rm(root, { recursive: true, force: true });
  }
}

export async function inspectLibrary(skills: readonly PreparedSkill[]): Promise<LibraryInspection> {
  const conflicts: string[] = [];
  const unchanged: string[] = [];
  for (const skill of skills) {
    const destination = join(libraryDir(), skill.name);
    if (!(await pathExists(destination))) continue;
    const candidateHash = await hashDirectory(skill.directory, { ignoreNames: new Set([".git"]), includeModes: true });
    const existingHash = await hashDirectory(destination, { includeModes: true }).catch(() => null);
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
  const releaseLock = await acquireLibraryLock();
  try {
    await recoverLibraryTransactions();
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
    const journal: TransactionJournal = {
      version: 1,
      phase: "prepared",
      entries: await Promise.all([...metadataNames].map(async (name) => ({
        name,
        metadataOnly: metadataOnly.has(name),
        hadSkill: await pathExists(join(libraryDir(), name)),
        hadMetadata: await pathExists(join(metadataDir(), `${name}.json`)),
      }))),
    };
    for (const entry of journal.entries) {
      if (!entry.metadataOnly && !inspection.conflicts.includes(entry.name) && (entry.hadSkill || entry.hadMetadata)) {
        throw new SkillenvError(`Library conflict appeared while installing: ${entry.name}`, "LIBRARY_CONFLICT");
      }
      if (entry.metadataOnly && entry.hadMetadata) {
        throw new SkillenvError(`Library metadata appeared while installing: ${entry.name}`, "LIBRARY_CONFLICT");
      }
    }

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
    await writeJson(join(transactionRoot, "journal.json"), journal).catch(async (error) => {
      await rm(transactionRoot, { recursive: true, force: true });
      throw error;
    });

  interface CommitRecord {
    name: string;
    skillBackedUp: boolean;
    metadataBackedUp: boolean;
    skillInstalled: boolean;
    metadataInstalled: boolean;
  }
  const committed: CommitRecord[] = [];
  async function rollback(): Promise<void> {
    try {
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
    } finally {
      await releaseLock();
    }
  }

  try {
    await mkdir(libraryDir(), { recursive: true });
    await mkdir(metadataDir(), { recursive: true });
    for (const name of metadataNames) {
      const destination = join(libraryDir(), name);
      const metadataDestination = join(metadataDir(), `${name}.json`);
      const record: CommitRecord = { name, skillBackedUp: false, metadataBackedUp: false, skillInstalled: false, metadataInstalled: false };
      committed.push(record);
      const expected = journal.entries.find((entry) => entry.name === name)!;
      if (await pathExists(destination) !== expected.hadSkill || await pathExists(metadataDestination) !== expected.hadMetadata) {
        throw new SkillenvError(`Library changed concurrently while installing: ${name}`, "LIBRARY_CONFLICT");
      }
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
    journal.phase = "committed";
    await writeJson(join(transactionRoot, "journal.json"), journal);
  } catch (error) {
    await rollback();
    throw error;
  }

    return {
      installed,
      replaced,
      unchanged: inspection.unchanged,
      rollback,
      finalize: async () => {
        try {
          await rm(transactionRoot, { recursive: true, force: true });
        } finally {
          await releaseLock();
        }
      },
    };
  } catch (error) {
    await releaseLock();
    throw error;
  }
}
