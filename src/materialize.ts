import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, rename, rm } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { ZodError } from "zod";
import { adapters, adapterSkillPath, isAdapterSkillPath } from "./adapters.js";
import { readEnvironment, withEnvironmentLock } from "./environments.js";
import { SkillenvError } from "./errors.js";
import { copyDirectory, hashDirectory, pathExists, readJson, removeEmptyParents, writeJson } from "./fs.js";
import { findProject, updateGitExclude, type Project } from "./git.js";
import { requireSkill, withLibraryReadLock } from "./library.js";
import { nameSchema, projectStateSchema, type Environment, type ProjectState } from "./schema.js";

function statePath(root: string): string {
  return join(root, ".skillenv", "state.json");
}

async function assertProjectMetadataRoot(root: string): Promise<void> {
  const metadataRoot = join(root, ".skillenv");
  const entry = await lstat(metadataRoot).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (entry && (entry.isSymbolicLink() || !entry.isDirectory())) {
    throw new SkillenvError("Refusing unsafe project metadata root: .skillenv", "RECOVERY_REQUIRED");
  }
}

async function entryExists(path: string): Promise<boolean> {
  return lstat(path).then(() => true).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return false;
    throw error;
  });
}

function resolveManagedPath(root: string, path: string, skill: string): string {
  if (!isAdapterSkillPath(path, skill)) {
    throw new SkillenvError(`Refusing unsafe managed path in project state: ${path}`);
  }
  const absolute = resolve(root, path);
  if (!absolute.startsWith(`${resolve(root)}${sep}`)) throw new SkillenvError(`Refusing path outside project: ${path}`);
  return absolute;
}

async function assertManagedAncestors(root: string, absolute: string): Promise<void> {
  const projectRoot = resolve(root);
  const parent = dirname(absolute);
  const segments = relative(projectRoot, parent).split(sep).filter(Boolean);
  let current = projectRoot;
  for (const segment of segments) {
    current = join(current, segment);
    const entry = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!entry) return;
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new SkillenvError(`Refusing managed path through unsafe project entry: ${relative(projectRoot, current)}`, "RECOVERY_REQUIRED");
    }
  }
}

async function checkedManagedPath(root: string, path: string, skill: string): Promise<string> {
  const absolute = resolveManagedPath(root, path, skill);
  await assertManagedAncestors(root, absolute);
  return absolute;
}

export async function readProjectState(root: string): Promise<ProjectState | null> {
  await assertProjectMetadataRoot(root);
  const path = statePath(root);
  if (!(await pathExists(path))) return null;
  try {
    return projectStateSchema.parse(await readJson(path));
  } catch (error) {
    if (error instanceof ZodError) throw new SkillenvError(`Invalid Skillenv project state: ${path}`);
    throw error;
  }
}

async function assertOwnedFilesUnchanged(root: string, state: ProjectState | null): Promise<void> {
  if (!state) return;
  for (const entry of state.managed) {
    const absolute = await checkedManagedPath(root, entry.path, entry.skill);
    if (!(await pathExists(absolute))) throw new SkillenvError(`Managed skill is missing: ${entry.path}. Restore it or remove .skillenv/state.json deliberately.`);
    const currentHash = await hashDirectory(absolute, { includeModes: state.hashVersion === 2 });
    if (currentHash !== entry.hash) {
      throw new SkillenvError(`Managed skill was modified: ${entry.path}. Skillenv will not overwrite or delete it.`);
    }
  }
}

export interface ActivationResult {
  project: Project;
  state: ProjectState;
  previousEnvironment: string | null;
}

interface ActivationJournal {
  version: 1;
  hashVersion?: 2;
  phase: "prepared" | "committed";
  previous: ProjectState | null;
  planned: Array<{ skill: string; path: string; hash: string }>;
}

function parseActivationJournal(value: unknown): ActivationJournal | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<ActivationJournal>;
  if (candidate.version !== 1 || (candidate.hashVersion !== undefined && candidate.hashVersion !== 2) || (candidate.phase !== "prepared" && candidate.phase !== "committed") || !Array.isArray(candidate.planned)) return null;
  const previous = candidate.previous === null ? null : projectStateSchema.safeParse(candidate.previous);
  if (previous !== null && !previous.success) return null;
  const planned: Array<{ skill: string; path: string; hash: string }> = [];
  for (const entry of candidate.planned) {
    if (!entry || typeof entry !== "object") return null;
    const item = entry as { skill?: unknown; path?: unknown };
    const skill = nameSchema.safeParse(item.skill);
    const hash = (entry as { hash?: unknown }).hash;
    if (!skill.success || typeof item.path !== "string" || !isAdapterSkillPath(item.path, skill.data) || typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash)) return null;
    planned.push({ skill: skill.data, path: item.path, hash });
  }
  return { version: 1, ...(candidate.hashVersion === 2 ? { hashVersion: 2 as const } : {}), phase: candidate.phase, previous: previous === null ? null : previous.data, planned };
}

async function acquireProjectLock(root: string): Promise<() => Promise<void>> {
  await assertProjectMetadataRoot(root);
  const lockRoot = join(root, ".skillenv", "locks");
  await mkdir(lockRoot, { recursive: true });
  const name = `activation-${process.pid}-${Date.now()}-${randomUUID()}`;
  const owned = join(lockRoot, name);
  await mkdir(owned);
  try {
    const contenders = await readdir(lockRoot, { withFileTypes: true });
    let active = false;
    for (const contender of contenders.filter((entry) => entry.isDirectory() && entry.name !== name)) {
      const match = /^activation-(\d+)-(\d+)-/.exec(contender.name);
      const pid = Number(match?.[1]);
      try {
        if (Number.isInteger(pid) && pid > 0) process.kill(pid, 0);
        else throw Object.assign(new Error(), { code: "ESRCH" });
        active = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") await rm(join(lockRoot, contender.name), { recursive: true, force: true });
        else active = true;
      }
    }
    if (active) throw new SkillenvError("Another Skillenv operation is updating this project", "PROJECT_BUSY");
  } catch (error) {
    await rm(owned, { recursive: true, force: true });
    throw error;
  }
  return async () => {
    await rm(owned, { recursive: true, force: true }).catch(() => {});
    await removeEmptyParents(lockRoot, root).catch(() => {});
  };
}

async function recoverActivationTransactions(project: Project): Promise<void> {
  await assertProjectMetadataRoot(project.root);
  const skillenvRoot = join(project.root, ".skillenv");
  const entries = await readdir(skillenvRoot, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  for (const entry of entries.filter((candidate) => candidate.isDirectory() && candidate.name.startsWith("staging-"))) {
    const root = join(skillenvRoot, entry.name);
    const journalPath = join(root, "journal.json");
    if (!(await pathExists(journalPath))) {
      await rm(root, { recursive: true, force: true });
      continue;
    }
    const journal = parseActivationJournal(await readJson(journalPath));
    if (!journal) throw new SkillenvError(`Invalid interrupted activation transaction: ${journalPath}`, "RECOVERY_REQUIRED");
    if (journal.phase === "prepared") {
      for (const planned of journal.planned) {
        if (!(await pathExists(join(root, "next", planned.path)))) {
          const destination = await checkedManagedPath(project.root, planned.path, planned.skill);
          if (await pathExists(destination)) {
            const plannedHash = await hashDirectory(destination, { includeModes: journal.hashVersion === 2 });
            const previous = journal.previous?.managed.find((item) => item.path === planned.path);
            const previousHash = previous ? await hashDirectory(destination, { includeModes: journal.previous?.hashVersion === 2 }) : null;
            const backup = previous ? join(root, "backup", previous.path) : null;
            const backupExists = backup ? await pathExists(backup) : false;
            if (previous && previousHash === previous.hash && !backupExists) {
              // A prior recovery pass already restored this path.
            } else if (plannedHash === planned.hash) await rm(destination, { recursive: true, force: true });
            else if (!(previous && previousHash === previous.hash && backup && !backupExists)) {
              throw new SkillenvError(`Interrupted activation path was modified: ${planned.path}`, "RECOVERY_REQUIRED");
            }
          }
        }
      }
      for (const previous of journal.previous?.managed ?? []) {
        const backup = join(root, "backup", previous.path);
        if (await pathExists(backup)) {
          const destination = await checkedManagedPath(project.root, previous.path, previous.skill);
          if (await pathExists(destination)) throw new SkillenvError(`Interrupted activation path was recreated: ${previous.path}`, "RECOVERY_REQUIRED");
          await mkdir(dirname(destination), { recursive: true });
          await rename(backup, destination);
        }
      }
      await (journal.previous ? writeJson(statePath(project.root), journal.previous) : rm(statePath(project.root), { force: true }));
      await updateGitExclude(project, journal.previous?.managed.map((item) => item.path) ?? []);
    }
    await rm(root, { recursive: true, force: true });
  }
}

async function hasActivationTransactions(root: string): Promise<boolean> {
  await assertProjectMetadataRoot(root);
  const entries = await readdir(join(root, ".skillenv"), { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  return entries.some((entry) => entry.isDirectory() && entry.name.startsWith("staging-"));
}

export async function activate(
  environmentName: string,
  cwd = process.cwd(),
  options: { libraryLockHeld?: boolean; expectedEnvironment?: Environment } = {},
): Promise<ActivationResult> {
  const operation = () => withEnvironmentLock(async () => {
    const environment = await readEnvironment(environmentName);
    if (options.expectedEnvironment && JSON.stringify(environment) !== JSON.stringify(options.expectedEnvironment)) {
      throw new SkillenvError(`Environment '${environmentName}' changed before activation`, "ENVIRONMENT_CHANGED");
    }
    const project = await findProject(cwd);
    const releaseLock = await acquireProjectLock(project.root);
    try {
      await recoverActivationTransactions(project);
      return await activateLocked(environment, project);
    } finally {
      await releaseLock();
    }
  });
  return options.libraryLockHeld ? operation() : withLibraryReadLock(operation);
}

async function activateLocked(environment: Environment, project: Project): Promise<ActivationResult> {
  const previous = await readProjectState(project.root);
  await assertOwnedFilesUnchanged(project.root, previous);

  const previousPaths = new Set(previous?.managed.map((entry) => entry.path) ?? []);
  const planned = adapters.flatMap((adapter) =>
    environment.skills.map((skill) => ({ skill, path: adapterSkillPath(adapter, skill) })),
  );

  for (const entry of planned) {
    const destination = await checkedManagedPath(project.root, entry.path, entry.skill);
    if ((await pathExists(destination)) && !previousPaths.has(entry.path)) {
      throw new SkillenvError(`Refusing to overwrite unmanaged skill: ${entry.path}`);
    }
  }

  const stagingRoot = join(project.root, ".skillenv", `staging-${randomUUID()}`);
  const backupRoot = join(stagingRoot, "backup");
  const journalPath = join(stagingRoot, "journal.json");
  const staged: Array<{ skill: string; path: string; stagedPath: string; hash: string }> = [];
  const installed: Array<{ skill: string; path: string; hash: string }> = [];
  const backedUp: Array<{ skill: string; path: string; backupPath: string }> = [];
  const journal: ActivationJournal = { version: 1, hashVersion: 2, phase: "prepared", previous, planned: [] };
  let preserveStaging = false;
  try {
    for (const entry of planned) {
      const source = await requireSkill(entry.skill);
      const sourceHash = await hashDirectory(source, { includeModes: true });
      const stagedPath = join(stagingRoot, "next", entry.path);
      await copyDirectory(source, stagedPath);
      const stagedHash = await hashDirectory(stagedPath, { includeModes: true });
      const currentSourceHash = await hashDirectory(source, { includeModes: true });
      if (sourceHash !== currentSourceHash || stagedHash !== sourceHash) {
        throw new SkillenvError(`Library skill changed while activating: ${entry.skill}`, "SOURCE_CHANGED");
      }
      staged.push({ ...entry, stagedPath, hash: stagedHash });
    }
    journal.planned = staged.map(({ skill, path, hash }) => ({ skill, path, hash }));
    await writeJson(journalPath, journal);

    for (const entry of previous?.managed ?? []) {
      const backupPath = join(backupRoot, entry.path);
      await mkdir(dirname(backupPath), { recursive: true });
      const destination = await checkedManagedPath(project.root, entry.path, entry.skill);
      if (await hashDirectory(destination, { includeModes: previous?.hashVersion === 2 }) !== entry.hash) {
        throw new SkillenvError(`Managed skill changed while activating: ${entry.path}`, "PROJECT_CHANGED");
      }
      await rename(destination, backupPath);
      backedUp.push({ skill: entry.skill, path: entry.path, backupPath });
      if (await hashDirectory(backupPath, { includeModes: previous?.hashVersion === 2 }) !== entry.hash) {
        throw new SkillenvError(`Managed skill changed while activating: ${entry.path}`, "PROJECT_CHANGED");
      }
    }
    for (const entry of staged) {
      const destination = await checkedManagedPath(project.root, entry.path, entry.skill);
      if (await entryExists(destination)) throw new SkillenvError(`Activation destination was recreated: ${entry.path}`, "PROJECT_CHANGED");
      await mkdir(dirname(destination), { recursive: true });
      await rename(entry.stagedPath, destination);
      installed.push({ skill: entry.skill, path: entry.path, hash: entry.hash });
    }

    const state: ProjectState = {
      version: 1,
      hashVersion: 2,
      environment: environment.name,
      activatedAt: new Date().toISOString(),
      managed: staged.map(({ skill, path, hash }) => ({ skill, path, hash })),
    };
    await writeJson(statePath(project.root), state);
    await updateGitExclude(project, state.managed.map((entry) => entry.path));
    journal.phase = "committed";
    await writeJson(journalPath, journal);
    return { project, state, previousEnvironment: previous?.environment ?? null };
  } catch (error) {
    const recoveryErrors: unknown[] = [];
    const recordStructuralError = (recoveryError: unknown) => {
      recoveryErrors.push(recoveryError);
    };
    for (const entry of [...installed].reverse()) {
      await checkedManagedPath(project.root, entry.path, entry.skill)
        .then(async (destination) => {
          if (await pathExists(destination)) {
            const currentHash = await hashDirectory(destination, { includeModes: true });
            if (currentHash !== entry.hash) {
              throw new SkillenvError(`Installed activation path was modified during rollback: ${entry.path}`, "RECOVERY_REQUIRED");
            }
            await rm(destination, { recursive: true, force: true });
          }
        })
        .catch(recordStructuralError);
    }
    for (const entry of [...backedUp].reverse()) {
      const destination = await checkedManagedPath(project.root, entry.path, entry.skill).catch((recoveryError) => {
        recordStructuralError(recoveryError);
        return null;
      });
      if (!destination) continue;
      if (await entryExists(destination)) {
        recordStructuralError(new SkillenvError(`Activation destination was recreated during rollback: ${entry.path}`, "RECOVERY_REQUIRED"));
        continue;
      }
      await mkdir(dirname(destination), { recursive: true }).catch(recordStructuralError);
      await rename(entry.backupPath, destination).catch(recordStructuralError);
    }
    await (previous ? writeJson(statePath(project.root), previous) : rm(statePath(project.root), { force: true }))
      .catch(recordStructuralError);
    await updateGitExclude(project, previous?.managed.map((entry) => entry.path) ?? [])
      .catch((recoveryError) => recoveryErrors.push(recoveryError));
    if (recoveryErrors.length) {
      preserveStaging = true;
      const original = error instanceof Error ? error.message : String(error);
      const recovery = recoveryErrors.map((item) => item instanceof Error ? item.message : String(item)).join("; ");
      throw new SkillenvError(`Activation failed: ${original}. Automatic recovery was incomplete: ${recovery}`, "RECOVERY_REQUIRED");
    }
    throw error;
  } finally {
    if (!preserveStaging) await rm(stagingRoot, { recursive: true, force: true }).catch(() => {});
  }
}

export interface StatusResult {
  project: Project;
  state: ProjectState | null;
  drifted: string[];
}

export async function getStatus(cwd = process.cwd(), options: { recover?: boolean } = {}): Promise<StatusResult> {
  const project = await findProject(cwd);
  if (options.recover !== false && await hasActivationTransactions(project.root)) {
    const releaseLock = await acquireProjectLock(project.root);
    try {
      await recoverActivationTransactions(project);
    } finally {
      await releaseLock();
    }
  }
  const state = await readProjectState(project.root);
  const drifted: string[] = [];
  for (const entry of state?.managed ?? []) {
    const absolute = await checkedManagedPath(project.root, entry.path, entry.skill);
    if (!(await pathExists(absolute)) || (await hashDirectory(absolute, { includeModes: state!.hashVersion === 2 })) !== entry.hash) drifted.push(entry.path);
  }
  return { project, state, drifted };
}

export async function deactivate(cwd = process.cwd()): Promise<{ project: Project; environment: string | null }> {
  const project = await findProject(cwd);
  const releaseLock = await acquireProjectLock(project.root);
  try {
    await recoverActivationTransactions(project);
    const state = await readProjectState(project.root);
    if (!state) {
      await updateGitExclude(project, []);
      return { project, environment: null };
    }
    await assertOwnedFilesUnchanged(project.root, state);
    for (const entry of state.managed) {
      const absolute = await checkedManagedPath(project.root, entry.path, entry.skill);
      await rm(absolute, { recursive: true });
      await removeEmptyParents(dirname(absolute), project.root);
    }
    await rm(statePath(project.root));
    await removeEmptyParents(dirname(statePath(project.root)), project.root);
    await updateGitExclude(project, []);
    return { project, environment: state.environment };
  } finally {
    await releaseLock();
  }
}
