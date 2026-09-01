import { createHash, randomUUID } from "node:crypto";
import { cp, lstat, mkdir, readdir, readFile, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import { SkillenvError } from "./errors.js";

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) throw new SkillenvError(`Invalid JSON in ${path}`);
    throw error;
  }
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

export async function copyDirectory(source: string, destination: string): Promise<void> {
  await mkdir(join(destination, ".."), { recursive: true });
  await cp(source, destination, { recursive: true, errorOnExist: true, force: false });
}

export async function copySkillDirectory(source: string, destination: string): Promise<void> {
  await mkdir(dirname(destination), { recursive: true });
  await cp(source, destination, {
    recursive: true,
    errorOnExist: true,
    force: false,
    filter: (path) => !relative(source, path).split(sep).includes(".git"),
  });
}

export async function hashDirectory(root: string, options: { ignoreNames?: ReadonlySet<string>; includeModes?: boolean } = {}): Promise<string> {
  const rootStat = await lstat(root);
  if (rootStat.isSymbolicLink()) throw new SkillenvError("Symbolic links are not supported as skill roots");
  if (!rootStat.isDirectory()) throw new SkillenvError("Skill roots must be directories");
  const hash = createHash("sha256");
  if (options.includeModes) hash.update(`m:${rootStat.mode & 0o777}\0`);

  async function visit(directory: string, prefix = ""): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (options.ignoreNames?.has(entry.name)) continue;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new SkillenvError(`Symbolic links are not supported in skills: ${relative}`);
      }
      if (options.includeModes) hash.update(`m:${(await lstat(absolute)).mode & 0o777}\0`);
      if (entry.isDirectory()) {
        hash.update(`d:${relative}\0`);
        await visit(absolute, relative);
      } else if (entry.isFile()) {
        hash.update(`f:${relative}\0`);
        hash.update(await readFile(absolute));
        hash.update("\0");
      } else {
        throw new SkillenvError(`Unsupported filesystem entry in skill: ${relative}`);
      }
    }
  }

  await visit(root);
  return hash.digest("hex");
}

export async function removeEmptyParents(start: string, stop: string): Promise<void> {
  let current = start;
  while (current.startsWith(stop) && current !== stop) {
    const entries = await readdir(current).catch(() => []);
    if (entries.length > 0) return;
    await rmdir(current);
    current = dirname(current);
  }
}

export function inferSkillName(source: string): string {
  return basename(source.replace(/[\\/]$/, ""));
}
