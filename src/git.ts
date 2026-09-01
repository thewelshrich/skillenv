import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";

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
  const lines = content.split(/\r?\n/);
  const output: string[] = [];
  let inside = false;
  for (const line of lines) {
    if (line === START) {
      inside = true;
      continue;
    }
    if (line === END && inside) {
      inside = false;
      continue;
    }
    if (!inside) output.push(line);
  }
  return output.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
}

export async function updateGitExclude(project: Project, managedPaths: string[]): Promise<void> {
  if (!project.gitExclude) return;
  const existing = await readFile(project.gitExclude, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  const base = stripSkillenvBlock(existing);
  const uniquePaths = [...new Set(managedPaths)].sort();
  const block = uniquePaths.length > 0
    ? [START, "/.skillenv/", ...uniquePaths.map((path) => `/${path.replaceAll("\\", "/")}/`), END].join("\n")
    : "";
  const next = [base, block].filter(Boolean).join(base && block ? "\n\n" : "");
  await mkdir(dirname(project.gitExclude), { recursive: true });
  await writeFile(project.gitExclude, next ? `${next}\n` : "");
}
