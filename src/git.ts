import { execFile } from "node:child_process";
import { lstat, readFile, readlink } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";
import { SkillenvError } from "./errors.js";
import { writeFileAtomic } from "./fs.js";

const execFileAsync = promisify(execFile);
const START = "# >>> skillenv";
const END = "# <<< skillenv";

export interface Project {
  root: string;
  gitExclude: string | null;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  return stdout.trim();
}

export async function findProject(cwd = process.cwd()): Promise<Project> {
  const startingDirectory = resolve(cwd);
  try {
    const root = await git(startingDirectory, ["rev-parse", "--show-toplevel"]);
    const rawExclude = await git(root, ["rev-parse", "--git-path", "info/exclude"]);
    return { root, gitExclude: isAbsolute(rawExclude) ? rawExclude : resolve(root, rawExclude) };
  } catch {
    return { root: startingDirectory, gitExclude: null };
  }
}

function stripSkillenvBlock(content: string): string {
  const output: string[] = [];
  let inside = false;
  for (const line of content.split("\n")) {
    const text = line.replace(/\r$/, "");
    if (inside) {
      if (text === END) inside = false;
      continue;
    }
    if (text === START) {
      // Drop the blank separator line written before the block.
      if (output.at(-1)?.replace(/\r$/, "") === "") output.pop();
      inside = true;
      continue;
    }
    output.push(line);
  }
  return output.join("\n");
}

// Follow symbolic links so an atomic rename updates the shared target instead of replacing the link.
async function resolveWriteTarget(path: string): Promise<string> {
  let current = path;
  for (let depth = 0; depth < 40; depth += 1) {
    const entry = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!entry?.isSymbolicLink()) return current;
    current = resolve(dirname(current), await readlink(current));
  }
  throw new SkillenvError(`Too many symbolic links resolving ${path}`);
}

export async function updateGitExclude(project: Project, managedPaths: string[]): Promise<void> {
  if (!project.gitExclude) return;
  const existing = await readFile(project.gitExclude, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  let next = stripSkillenvBlock(existing);
  const uniquePaths = [...new Set(managedPaths)].sort();
  if (uniquePaths.length > 0) {
    if (next && !next.endsWith("\n")) next += "\n";
    const block = [START, "/.skillenv/", ...uniquePaths.map((path) => `/${path.replaceAll("\\", "/")}/`), END].join("\n");
    next += `${next ? "\n" : ""}${block}\n`;
  }
  if (next === existing) return;
  await writeFileAtomic(await resolveWriteTarget(project.gitExclude), next);
}
