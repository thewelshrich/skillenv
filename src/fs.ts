import { createHash } from "node:crypto";
import { cp, mkdir, readdir, readFile, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
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
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

export async function copyDirectory(source: string, destination: string): Promise<void> {
  await mkdir(join(destination, ".."), { recursive: true });
  await cp(source, destination, { recursive: true, errorOnExist: true, force: false });
}

export async function hashDirectory(root: string): Promise<string> {
  const hash = createHash("sha256");

  async function visit(directory: string, prefix = ""): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new SkillenvError(`Symbolic links are not supported in skills: ${relative}`);
      }
      if (entry.isDirectory()) {
        hash.update(`d:${relative}\0`);
        await visit(absolute, relative);
      } else if (entry.isFile()) {
        hash.update(`f:${relative}\0`);
        hash.update(await readFile(absolute));
        hash.update("\0");
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
