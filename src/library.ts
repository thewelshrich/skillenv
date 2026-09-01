import { randomUUID } from "node:crypto";
import { cp, lstat, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { SkillenvError } from "./errors.js";
import { withEnvironmentLock } from "./environments.js";
import { copySkillDirectory, fingerprintEntry, hashDirectory, inferSkillName, pathExists, readJson, writeJson } from "./fs.js";
import { environmentsDir, libraryDir, metadataDir, transactionsDir } from "./paths.js";
import { environmentSchema, nameSchema, type Environment, type SkillMetadata } from "./schema.js";
import { sanitizeSourceInput } from "./sources.js";

async function entryExists(path: string): Promise<boolean> {
  return lstat(path).then(() => true).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return false;
    throw error;
  });
}

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
  fingerprints: Record<string, string>;
  existingFingerprints: Record<string, string>;
  metadataFingerprints: Record<string, string>;
}

interface TransactionEntry {
  name: string;
  metadataOnly: boolean;
  hadSkill: boolean;
  hadMetadata: boolean;
  installedHash?: string;
}

interface TransactionJournal {
  version: 1;
  phase: "prepared" | "committed";
  entries: TransactionEntry[];
  environment?: { name: string; previous: Environment | null; next: Environment };
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
    if (!item.metadataOnly && (typeof item.installedHash !== "string" || !/^[a-f0-9]{64}$/.test(item.installedHash))) return null;
    if (item.metadataOnly && item.installedHash !== undefined && (typeof item.installedHash !== "string" || !/^[a-f0-9]{64}$/.test(item.installedHash))) return null;
    entries.push({ name: parsedName.data, metadataOnly: item.metadataOnly, hadSkill: item.hadSkill, hadMetadata: item.hadMetadata, ...(item.installedHash ? { installedHash: item.installedHash } : {}) });
  }
  let environment: TransactionJournal["environment"];
  if (candidate.environment !== undefined) {
    const value = candidate.environment as TransactionJournal["environment"];
    const name = nameSchema.safeParse(value?.name);
    const previous = value?.previous === null ? null : environmentSchema.safeParse(value?.previous);
    const next = environmentSchema.safeParse(value?.next);
    if (!name.success || (previous !== null && !previous.success) || !next.success || next.data.name !== name.data || (previous !== null && previous.data.name !== name.data)) return null;
    environment = { name: name.data, previous: previous === null ? null : previous.data, next: next.data };
  }
  return { version: 1, phase: candidate.phase, entries, ...(environment ? { environment } : {}) };
}

const locksDir = () => join(transactionsDir(), "locks");
const LOCK_STALE_MS = 30 * 60 * 1000;

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function acquireLibraryLock(): Promise<() => Promise<void>> {
  await mkdir(locksDir(), { recursive: true });
  const lockName = `install-${process.pid}-${Date.now()}-${randomUUID()}`;
  const ownedLock = join(locksDir(), lockName);
  await mkdir(ownedLock);
  try {
    const contenders = await readdir(locksDir(), { withFileTypes: true });
    let activeContender = false;
    for (const contender of contenders.filter((entry) => entry.isDirectory() && entry.name !== lockName)) {
      const match = /^install-(\d+)-(\d+)-/.exec(contender.name);
      const pid = Number(match?.[1]);
      const createdAt = Number(match?.[2]);
      if (Number.isInteger(pid) && pid > 0 && processIsRunning(pid) && Number.isFinite(createdAt) && Date.now() - createdAt < LOCK_STALE_MS) activeContender = true;
      else await rm(join(locksDir(), contender.name), { recursive: true, force: true });
    }
    if (activeContender) throw new SkillenvError("Another skill installation is already updating the library", "LIBRARY_BUSY");
  } catch (error) {
    await rm(ownedLock, { recursive: true, force: true });
    throw error;
  }
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    await rm(ownedLock, { recursive: true, force: true }).catch(() => {});
  };
}

async function recoverLibraryTransactions(): Promise<void> {
  const entries = await readdir(transactionsDir(), { withFileTypes: true });
  for (const entry of entries.filter((candidate) => candidate.isDirectory() && candidate.name !== "locks")) {
    const root = join(transactionsDir(), entry.name);
    const journalPath = join(root, "journal.json");
    const journalValue = await pathExists(journalPath) ? await readJson(journalPath) : null;
    const journal = transactionJournal(journalValue);
    if (journalValue && !journal) throw new SkillenvError(`Invalid interrupted library transaction: ${journalPath}`, "RECOVERY_REQUIRED");
    const backupSkills = join(root, "backup", "skills");
    const backupMetadata = join(root, "backup", "metadata");
    if (journal?.version === 1 && journal.phase === "prepared") {
      if (journal.environment) {
        await withEnvironmentLock(async () => {
          const path = join(environmentsDir(), `${journal.environment!.name}.json`);
          const exists = await pathExists(path);
          const current = exists ? environmentSchema.parse(await readJson(path)) : null;
          const matches = (left: Environment | null, right: Environment | null) => JSON.stringify(left) === JSON.stringify(right);
          if (matches(current, journal.environment!.next)) {
            if (journal.environment!.previous) await writeJson(path, journal.environment!.previous);
            else await rm(path, { force: true });
          } else if (!matches(current, journal.environment!.previous)) {
            throw new SkillenvError(`Environment '${journal.environment!.name}' changed during interrupted recovery`, "RECOVERY_REQUIRED");
          }
        });
      }
      for (const item of [...journal.entries].reverse()) {
        const destination = join(libraryDir(), item.name);
        const metadataDestination = join(metadataDir(), `${item.name}.json`);
        const skillBackup = join(backupSkills, item.name);
        const metadataBackup = join(backupMetadata, `${item.name}.json`);
        if (!item.metadataOnly) {
          const backupExists = await pathExists(skillBackup);
          if (await entryExists(destination) && item.installedHash && (backupExists || !item.hadSkill)) {
            const currentHash = await hashDirectory(destination, { includeModes: true }).catch(() => null);
            if (currentHash !== item.installedHash) throw new SkillenvError(`Interrupted library skill was modified: ${item.name}`, "RECOVERY_REQUIRED");
          }
          if (backupExists) {
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
      const skillBackups = await readdir(backupSkills, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      });
      for (const backup of skillBackups) {
        const destination = join(libraryDir(), backup.name);
        if (!(await pathExists(destination))) {
          await mkdir(libraryDir(), { recursive: true });
          await rename(join(backupSkills, backup.name), destination);
        }
      }
      const metadataBackups = await readdir(backupMetadata, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      });
      for (const backup of metadataBackups) {
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
  const fingerprints: Record<string, string> = {};
  const existingFingerprints: Record<string, string> = {};
  const metadataFingerprints: Record<string, string> = {};
  const existingNames = await listSkills();
  const existingByCase = new Map(existingNames.map((name) => [name.toLocaleLowerCase("en-US"), name]));
  for (const skill of skills) {
    const alias = existingByCase.get(skill.name.toLocaleLowerCase("en-US"));
    if (alias && alias !== skill.name) throw new SkillenvError(`Library skill names '${alias}' and '${skill.name}' collide on case-insensitive filesystems`, "DUPLICATE_SKILL");
    const destination = join(libraryDir(), skill.name);
    const candidateHash = await hashDirectory(skill.directory, { ignoreNames: new Set([".git"]), includeModes: true });
    fingerprints[skill.name] = candidateHash;
    const metadataPath = join(metadataDir(), `${skill.name}.json`);
    const metadataExists = await entryExists(metadataPath);
    if (metadataExists) metadataFingerprints[skill.name] = await fingerprintEntry(metadataPath);
    if (!(await entryExists(destination))) {
      if (metadataExists) conflicts.push(skill.name);
      continue;
    }
    existingFingerprints[skill.name] = await fingerprintEntry(destination);
    const existingHash = await hashDirectory(destination, { includeModes: true }).catch(() => null);
    if (existingHash === null) {
      conflicts.push(skill.name);
      continue;
    }
    if (existingHash === candidateHash) unchanged.push(skill.name);
    else conflicts.push(skill.name);
  }
  return { conflicts, unchanged, fingerprints, existingFingerprints, metadataFingerprints };
}

export interface LibraryChange {
  installed: string[];
  replaced: string[];
  unchanged: string[];
  recordEnvironment(previous: Environment | null, next: Environment): Promise<void>;
  rollback(): Promise<void>;
  finalize(): Promise<void>;
}

export async function installLibrarySkills(
  skills: readonly PreparedSkill[],
  source: { input: string; kind: "local" | "git"; revision: string | null },
  options: { replace: boolean; allowedConflicts?: readonly string[] },
): Promise<LibraryChange> {
  const releaseLock = await acquireLibraryLock();
  try {
    await recoverLibraryTransactions();
    const inspection = await inspectLibrary(skills);
    if (inspection.conflicts.length && !options.replace) {
      throw new SkillenvError(`Library conflicts: ${inspection.conflicts.join(", ")}`, "LIBRARY_CONFLICT");
    }
    if (options.allowedConflicts) {
      const allowed = new Set(options.allowedConflicts);
      const unexpected = inspection.conflicts.filter((name) => !allowed.has(name));
      if (unexpected.length) throw new SkillenvError(`Library conflicts changed before installation: ${unexpected.join(", ")}`, "LIBRARY_CONFLICT_CHANGED");
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
    if (!(await entryExists(join(metadataDir(), `${skill.name}.json`)))) metadataOnly.add(skill.name);
  }
    const metadataNames = new Set([...installed, ...metadataOnly]);
    const journal: TransactionJournal = {
      version: 1,
      phase: "prepared",
      entries: await Promise.all([...metadataNames].map(async (name) => ({
        name,
        metadataOnly: metadataOnly.has(name),
        hadSkill: await entryExists(join(libraryDir(), name)),
        hadMetadata: await entryExists(join(metadataDir(), `${name}.json`)),
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
    await mkdir(stagedSkills, { recursive: true });
    await mkdir(stagedMetadata, { recursive: true });
    for (const skill of skills.filter((candidate) => metadataNames.has(candidate.name))) {
      const stagedSkill = join(stagedSkills, skill.name);
      if (!metadataOnly.has(skill.name)) await copySkillDirectory(skill.directory, stagedSkill);
      if (!metadataOnly.has(skill.name)) {
        const stagedHash = await hashDirectory(stagedSkill, { includeModes: true });
        if (stagedHash !== inspection.fingerprints[skill.name]) throw new SkillenvError(`Skill source changed during installation: ${skill.name}`, "SOURCE_CHANGED");
        journal.entries.find((entry) => entry.name === skill.name)!.installedHash = stagedHash;
      }
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
    for (const skill of skills.filter((candidate) => unchanged.has(candidate.name))) {
      const current = await hashDirectory(skill.directory, { ignoreNames: new Set([".git"]), includeModes: true });
      if (current !== inspection.fingerprints[skill.name]) throw new SkillenvError(`Skill source changed during installation: ${skill.name}`, "SOURCE_CHANGED");
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
      journal.phase = "prepared";
      await writeJson(join(transactionRoot, "journal.json"), journal);
      for (const record of [...committed].reverse()) {
        const { name } = record;
        if (record.skillInstalled) {
          const destination = join(libraryDir(), name);
          if (await entryExists(destination)) {
            const expectedHash = journal.entries.find((entry) => entry.name === name)?.installedHash;
            const currentHash = await hashDirectory(destination, { includeModes: true }).catch(() => null);
            if (!expectedHash || currentHash !== expectedHash) {
              throw new SkillenvError(`Installed library skill was modified during rollback: ${name}`, "RECOVERY_REQUIRED");
            }
            await rm(destination, { recursive: true, force: true });
          }
        }
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
      if (await entryExists(destination) !== expected.hadSkill || await entryExists(metadataDestination) !== expected.hadMetadata) {
        throw new SkillenvError(`Library changed concurrently while installing: ${name}`, "LIBRARY_CONFLICT");
      }
      if (!metadataOnly.has(name) && await entryExists(destination)) {
        const currentFingerprint = await fingerprintEntry(destination);
        if (currentFingerprint !== inspection.existingFingerprints[name]) {
          throw new SkillenvError(`Library skill changed while installing: ${name}`, "LIBRARY_CONFLICT_CHANGED");
        }
        await mkdir(backupSkills, { recursive: true });
        const backup = join(backupSkills, name);
        await rename(destination, backup);
        record.skillBackedUp = true;
        if (await fingerprintEntry(backup) !== inspection.existingFingerprints[name]) {
          throw new SkillenvError(`Library skill changed while installing: ${name}`, "LIBRARY_CONFLICT_CHANGED");
        }
      }
      if (await entryExists(metadataDestination)) {
        const currentFingerprint = await fingerprintEntry(metadataDestination);
        if (currentFingerprint !== inspection.metadataFingerprints[name]) {
          throw new SkillenvError(`Library metadata changed while installing: ${name}`, "LIBRARY_CONFLICT_CHANGED");
        }
        await mkdir(backupMetadata, { recursive: true });
        const backup = join(backupMetadata, `${name}.json`);
        await rename(metadataDestination, backup);
        record.metadataBackedUp = true;
        if (await fingerprintEntry(backup) !== inspection.metadataFingerprints[name]) {
          throw new SkillenvError(`Library metadata changed while installing: ${name}`, "LIBRARY_CONFLICT_CHANGED");
        }
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
      recordEnvironment: async (previous, next) => {
        journal.environment = { name: next.name, previous, next };
        await writeJson(join(transactionRoot, "journal.json"), journal);
      },
      rollback,
      finalize: async () => {
        try {
          journal.phase = "committed";
          await writeJson(join(transactionRoot, "journal.json"), journal).catch(async () => {
            await rm(transactionRoot, { recursive: true, force: true });
          });
          await rm(transactionRoot, { recursive: true, force: true }).catch(() => {});
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
