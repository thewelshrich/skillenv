import { execFile } from "node:child_process";
import { lstat, mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { parse } from "yaml";
import { SkillenvError } from "./errors.js";
import { pathExists } from "./fs.js";
import { nameSchema } from "./schema.js";

const execFileAsync = promisify(execFile);

export function sanitizeSourceInput(input: string): string {
  try {
    const source = new URL(input);
    if ((source.protocol === "http:" || source.protocol === "https:") && (source.username || source.password)) {
      source.username = "";
      source.password = "";
      return source.toString();
    }
  } catch {
    // Local paths and Git's SCP-style syntax are not URLs.
  }
  return input;
}

export interface SkillCandidate {
  name: string;
  description: string;
  directory: string;
  sourcePath: string;
}

export interface ResolvedSource {
  input: string;
  kind: "local" | "git";
  root: string;
  revision: string | null;
  skills: SkillCandidate[];
  cleanup(): Promise<void>;
}

function splitRef(input: string): { source: string; ref?: string } {
  const index = input.lastIndexOf("#");
  if (index <= input.indexOf("://") + 2) return { source: input };
  return { source: input.slice(0, index), ref: input.slice(index + 1) || undefined };
}

function gitUrl(input: string): { url: string; ref?: string } | null {
  const { source, ref } = splitRef(input);
  if (/^[\w.-]+\/[\w.-]+$/.test(source)) {
    return { url: `https://github.com/${source.replace(/\.git$/, "")}.git`, ref };
  }
  if (/^(https?:\/\/|ssh:\/\/|file:\/\/|git@)/.test(source)) return { url: source, ref };
  return null;
}

function frontmatter(content: string): Record<string, unknown> {
  if (!content.startsWith("---")) return {};
  const end = content.indexOf("\n---", 3);
  if (end < 0) return {};
  const value = parse(content.slice(3, end));
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

async function candidateAt(directory: string, root: string): Promise<SkillCandidate | null> {
  const skillFile = join(directory, "SKILL.md");
  if (!(await pathExists(skillFile))) return null;
  const fileStat = await lstat(skillFile);
  if (!fileStat.isFile() || fileStat.isSymbolicLink()) throw new SkillenvError(`Invalid SKILL.md at ${relative(root, skillFile)}`, "INVALID_SKILL");
  try {
    const metadata = frontmatter(await readFile(skillFile, "utf8"));
    const name = nameSchema.parse(typeof metadata.name === "string" ? metadata.name : basename(directory));
    return {
      name,
      description: typeof metadata.description === "string" ? metadata.description.trim() : "No description provided",
      directory,
      sourcePath: relative(root, directory) || ".",
    };
  } catch (error) {
    if (error instanceof SkillenvError) throw error;
    throw new SkillenvError(`Invalid SKILL.md metadata at ${relative(root, skillFile)}`, "INVALID_SKILL");
  }
}

async function discoverSkills(root: string): Promise<SkillCandidate[]> {
  const rootSkill = await candidateAt(root, root);
  if (rootSkill) return [rootSkill];
  const directories: string[] = [];
  const canonicalRoot = await realpath(root);
  for (const collection of ["skills", ".agents/skills", ".claude/skills"]) {
    const collectionRoot = join(root, collection);
    let prefix = root;
    for (const segment of collection.split("/")) {
      prefix = join(prefix, segment);
      const segmentStat = await lstat(prefix).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (!segmentStat) break;
      if (segmentStat.isSymbolicLink()) throw new SkillenvError(`Invalid skill collection: ${collection}`, "INVALID_SKILL");
    }
    const collectionStat = await lstat(collectionRoot).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!collectionStat) continue;
    if (collectionStat.isSymbolicLink() || !collectionStat.isDirectory()) {
      throw new SkillenvError(`Invalid skill collection: ${collection}`, "INVALID_SKILL");
    }
    const canonicalCollection = await realpath(collectionRoot);
    if (canonicalCollection !== canonicalRoot && !canonicalCollection.startsWith(`${canonicalRoot}${sep}`)) {
      throw new SkillenvError(`Skill collection escapes source root: ${collection}`, "INVALID_SKILL");
    }
    const entries = await readdir(collectionRoot, { withFileTypes: true });
    directories.push(...entries.filter((entry) => entry.isDirectory()).map((entry) => join(collectionRoot, entry.name)));
  }

  const found = (await Promise.all(directories.map((directory) => candidateAt(directory, root)))).filter((skill): skill is SkillCandidate => skill !== null);
  const byName = new Map<string, SkillCandidate>();
  for (const skill of found) {
    const existing = byName.get(skill.name);
    if (existing) throw new SkillenvError(`Duplicate skill name '${skill.name}' at ${existing.sourcePath} and ${skill.sourcePath}`, "DUPLICATE_SKILL");
    byName.set(skill.name, skill);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name) || a.sourcePath.localeCompare(b.sourcePath));
}

export async function resolveSource(input: string): Promise<ResolvedSource> {
  const local = resolve(input);
  const localStat = await lstat(local).catch(() => null);
  if (localStat?.isSymbolicLink()) throw new SkillenvError(`Symbolic link sources are not supported: ${input}`, "INVALID_SKILL");
  if (localStat?.isDirectory()) {
    const skills = await discoverSkills(local);
    if (!skills.length) throw new SkillenvError(`No skills found in ${input}`, "NO_SKILLS_FOUND");
    return { input, kind: "local", root: local, revision: null, skills, cleanup: async () => {} };
  }

  const remote = gitUrl(input);
  if (!remote) throw new SkillenvError(`Source is neither a local directory nor a supported Git source: ${input}`, "SOURCE_UNSUPPORTED");
  const temporaryRoot = await mkdtemp(join(tmpdir(), "skillenv-source-"));
  const checkout = join(temporaryRoot, "repository");
  try {
    const args = ["clone", "--depth", "1", "--filter=blob:none"];
    if (remote.ref) args.push("--branch", remote.ref);
    args.push(remote.url, checkout);
    await execFileAsync("git", args, { encoding: "utf8", maxBuffer: 1024 * 1024 });
    const { stdout } = await execFileAsync("git", ["-C", checkout, "rev-parse", "HEAD"], { encoding: "utf8" });
    const skills = await discoverSkills(checkout);
    if (!skills.length) throw new SkillenvError(`No skills found in ${input}`, "NO_SKILLS_FOUND");
    return {
      input,
      kind: "git",
      root: checkout,
      revision: stdout.trim(),
      skills,
      cleanup: () => rm(temporaryRoot, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(temporaryRoot, { recursive: true, force: true });
    if (error instanceof SkillenvError) throw error;
    const detail = (error as { stderr?: string }).stderr?.trim();
    throw new SkillenvError(`Could not fetch ${input}${detail ? `: ${detail}` : ""}`, "SOURCE_UNREACHABLE");
  }
}
