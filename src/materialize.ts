import { randomUUID } from "node:crypto";
import { mkdir, rename, rm } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { ZodError } from "zod";
import { adapters, adapterSkillPath, isAdapterSkillPath } from "./adapters.js";
import { readEnvironment } from "./environments.js";
import { SkillenvError } from "./errors.js";
import { copyDirectory, hashDirectory, pathExists, readJson, removeEmptyParents, writeJson } from "./fs.js";
import { findProject, updateGitExclude, type Project } from "./git.js";
import { requireSkill } from "./library.js";
import { projectStateSchema, type ProjectState } from "./schema.js";

function statePath(root: string): string {
  return join(root, ".skillenv", "state.json");
}

function resolveManagedPath(root: string, path: string, skill: string): string {
  if (!isAdapterSkillPath(path, skill)) {
    throw new SkillenvError(`Refusing unsafe managed path in project state: ${path}`);
  }
  const absolute = resolve(root, path);
  if (!absolute.startsWith(`${resolve(root)}${sep}`)) throw new SkillenvError(`Refusing path outside project: ${path}`);
  return absolute;
}

export async function readProjectState(root: string): Promise<ProjectState | null> {
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
    const absolute = resolveManagedPath(root, entry.path, entry.skill);
    if (!(await pathExists(absolute))) throw new SkillenvError(`Managed skill is missing: ${entry.path}. Restore it or remove .skillenv/state.json deliberately.`);
    const currentHash = await hashDirectory(absolute);
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

export async function activate(environmentName: string, cwd = process.cwd()): Promise<ActivationResult> {
  const environment = await readEnvironment(environmentName);
  const project = await findProject(cwd);
  const previous = await readProjectState(project.root);
  await assertOwnedFilesUnchanged(project.root, previous);

  const previousPaths = new Set(previous?.managed.map((entry) => entry.path) ?? []);
  const planned = adapters.flatMap((adapter) =>
    environment.skills.map((skill) => ({ skill, path: adapterSkillPath(adapter, skill) })),
  );

  for (const entry of planned) {
    const destination = join(project.root, entry.path);
    if ((await pathExists(destination)) && !previousPaths.has(entry.path)) {
      throw new SkillenvError(`Refusing to overwrite unmanaged skill: ${entry.path}`);
    }
  }

  const stagingRoot = join(project.root, ".skillenv", `staging-${randomUUID()}`);
  const staged: Array<{ skill: string; path: string; stagedPath: string; hash: string }> = [];
  try {
    for (const entry of planned) {
      const source = await requireSkill(entry.skill);
      const stagedPath = join(stagingRoot, entry.path);
      await copyDirectory(source, stagedPath);
      staged.push({ ...entry, stagedPath, hash: await hashDirectory(stagedPath) });
    }

    for (const entry of previous?.managed ?? []) {
      await rm(resolveManagedPath(project.root, entry.path, entry.skill), { recursive: true });
    }
    for (const entry of staged) {
      const destination = join(project.root, entry.path);
      await mkdir(dirname(destination), { recursive: true });
      await rename(entry.stagedPath, destination);
    }

    const state: ProjectState = {
      version: 1,
      environment: environment.name,
      activatedAt: new Date().toISOString(),
      managed: staged.map(({ skill, path, hash }) => ({ skill, path, hash })),
    };
    await writeJson(statePath(project.root), state);
    await updateGitExclude(project, state.managed.map((entry) => entry.path));
    return { project, state, previousEnvironment: previous?.environment ?? null };
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
}

export interface StatusResult {
  project: Project;
  state: ProjectState | null;
  drifted: string[];
}

export async function getStatus(cwd = process.cwd()): Promise<StatusResult> {
  const project = await findProject(cwd);
  const state = await readProjectState(project.root);
  const drifted: string[] = [];
  for (const entry of state?.managed ?? []) {
    const absolute = resolveManagedPath(project.root, entry.path, entry.skill);
    if (!(await pathExists(absolute)) || (await hashDirectory(absolute)) !== entry.hash) drifted.push(entry.path);
  }
  return { project, state, drifted };
}

export async function deactivate(cwd = process.cwd()): Promise<{ project: Project; environment: string | null }> {
  const project = await findProject(cwd);
  const state = await readProjectState(project.root);
  if (!state) {
    await updateGitExclude(project, []);
    return { project, environment: null };
  }
  await assertOwnedFilesUnchanged(project.root, state);
  for (const entry of state.managed) {
    const absolute = resolveManagedPath(project.root, entry.path, entry.skill);
    await rm(absolute, { recursive: true });
    await removeEmptyParents(dirname(absolute), project.root);
  }
  await rm(statePath(project.root));
  await removeEmptyParents(dirname(statePath(project.root)), project.root);
  await updateGitExclude(project, []);
  return { project, environment: state.environment };
}
