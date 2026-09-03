import { execFile } from "node:child_process";
import { chmod, lstat, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { parse } from "yaml";
import { SkillenvError } from "./errors.js";
import { hashDirectory, pathExists } from "./fs.js";
import { nameSchema } from "./schema.js";

const execFileAsync = promisify(execFile);

export interface GitCloneAuthentication {
  url: string;
  env: NodeJS.ProcessEnv;
}

function decodeUrlCredential(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export async function prepareGitCloneAuthentication(input: string, temporaryRoot: string): Promise<GitCloneAuthentication> {
  let source: URL;
  try {
    source = new URL(input);
  } catch {
    return { url: input, env: process.env };
  }
  if (!source.username && !source.password) return { url: input, env: process.env };

  const username = decodeUrlCredential(source.username);
  const password = decodeUrlCredential(source.password);
  source.username = "";
  source.password = "";
  const askpass = join(temporaryRoot, "git-askpass.sh");
  await writeFile(askpass, '#!/bin/sh\ncase "$1" in\n  *Username*) printf \'%s\\n\' "$SKILLENV_GIT_USERNAME" ;;\n  *) printf \'%s\\n\' "$SKILLENV_GIT_PASSWORD" ;;\nesac\n', { mode: 0o700 });
  await chmod(askpass, 0o700);
  return {
    url: source.toString(),
    env: {
      ...process.env,
      GIT_ASKPASS: askpass,
      GIT_TERMINAL_PROMPT: "0",
      SKILLENV_GIT_USERNAME: username,
      SKILLENV_GIT_PASSWORD: password,
    },
  };
}

export function sanitizeSourceInput(input: string): string {
  try {
    const source = new URL(input);
    if (source.username || source.password) {
      source.username = "";
      source.password = "";
      return source.toString();
    }
  } catch {
    // Local paths and Git's SCP-style syntax are not URLs.
  }
  return input;
}

function sanitizeSourceText(input: string): string {
  return terminalSafeLine(input.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, "$1"));
}

export interface SkillCandidate {
  name: string;
  description: string;
  directory: string;
  sourcePath: string;
  discoveryHash: string;
}

export interface ResolvedSource {
  input: string;
  kind: "local" | "git";
  root: string;
  selectedPath: string | null;
  revision: string | null;
  skills: SkillCandidate[];
  cleanup(): Promise<void>;
}

export interface ResolveSourceOptions {
  path?: string;
}

interface GitSource {
  url: string;
  ref?: string;
  path?: string;
}

const UNSAFE_PATH_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;

function normalizeSourcePath(input: string): string {
  if (!input || input === "." || input.includes("\\") || input.startsWith("/") || UNSAFE_PATH_CHARACTERS.test(input)) {
    throw new SkillenvError(`Invalid source path: ${terminalSafeLine(input) || "(empty)"}`, "INVALID_SOURCE_PATH");
  }
  const segments = input.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..") || /^[a-zA-Z]:/.test(segments[0]!)) {
    throw new SkillenvError(`Invalid source path: ${terminalSafeLine(input)}`, "INVALID_SOURCE_PATH");
  }
  return segments.join("/");
}

function splitRef(input: string): { source: string; ref?: string } {
  const index = input.lastIndexOf("#");
  if (index <= input.indexOf("://") + 2) return { source: input };
  const ref = input.slice(index + 1);
  if (!ref) throw new SkillenvError("Git source ref cannot be empty", "INVALID_INPUT");
  return { source: input.slice(0, index), ref };
}

function githubTreeUrl(input: string): GitSource | null {
  let source: URL;
  try {
    source = new URL(input);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(source.protocol) || !["github.com", "www.github.com"].includes(source.hostname.toLowerCase())) return null;
  const rawSegments = source.pathname.split("/").slice(1);
  if (rawSegments[2] !== "tree") return null;
  if (source.hash || rawSegments.length < 4 || !rawSegments[0] || !rawSegments[1] || !rawSegments[3]) {
    throw new SkillenvError("Invalid GitHub tree URL", "INVALID_INPUT");
  }
  let segments: string[];
  try {
    segments = rawSegments.map((segment) => decodeURIComponent(segment));
  } catch {
    throw new SkillenvError("Invalid percent-encoding in GitHub tree URL", "INVALID_INPUT");
  }
  const ref = segments[3]!;
  if (ref.includes("/")) {
    throw new SkillenvError("GitHub tree URLs cannot disambiguate refs containing '/'; use owner/repo#ref with --path", "INVALID_INPUT");
  }
  const path = segments.length > 4 ? normalizeSourcePath(segments.slice(4).join("/")) : undefined;
  const repository = segments[1]!.replace(/\.git$/, "");
  source.pathname = `/${segments[0]}/${repository}.git`;
  source.search = "";
  source.hash = "";
  return { url: source.toString(), ref, path };
}

function gitUrl(input: string): GitSource | null {
  const tree = githubTreeUrl(input);
  if (tree) return tree;
  const { source, ref } = splitRef(input);
  if (!source.startsWith("./") && !source.startsWith("../") && /^[\w.-]+\/[\w.-]+$/.test(source)) {
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

function terminalSafeLine(input: string): string {
  return input.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ").replace(/\s+/g, " ").trim();
}

async function candidateAt(directory: string, root: string, fallbackName = basename(directory)): Promise<SkillCandidate | null> {
  const skillFile = join(directory, "SKILL.md");
  if (!(await pathExists(skillFile))) return null;
  const fileStat = await lstat(skillFile);
  const sourcePath = terminalSafeLine(relative(root, directory) || ".");
  const displaySkillFile = terminalSafeLine(relative(root, skillFile));
  if (!fileStat.isFile() || fileStat.isSymbolicLink()) throw new SkillenvError(`Invalid SKILL.md at ${displaySkillFile}`, "INVALID_SKILL");
  try {
    const metadata = frontmatter(await readFile(skillFile, "utf8"));
    const name = nameSchema.parse(typeof metadata.name === "string" ? metadata.name : fallbackName);
    const discoveryHash = await hashDirectory(directory, { ignoreNames: new Set([".git"]), includeModes: true });
    return {
      name,
      description: typeof metadata.description === "string" ? terminalSafeLine(metadata.description) : "No description provided",
      directory,
      sourcePath,
      discoveryHash,
    };
  } catch (error) {
    if (error instanceof SkillenvError) throw error;
    throw new SkillenvError(`Invalid SKILL.md metadata at ${displaySkillFile}`, "INVALID_SKILL");
  }
}

const SKILL_COLLECTIONS = ["skills", ".agents/skills", ".claude/skills", ".github/skills"] as const;

function collectionPriority(sourcePath: string): number {
  const priority = SKILL_COLLECTIONS.findIndex((collection) => sourcePath.startsWith(`${collection}/`));
  return priority < 0 ? SKILL_COLLECTIONS.length : priority;
}

function coalesceCandidates(found: readonly SkillCandidate[]): SkillCandidate[] {
  const exactNames = new Map<string, SkillCandidate[]>();
  for (const skill of found) {
    const group = exactNames.get(skill.name) ?? [];
    group.push(skill);
    exactNames.set(skill.name, group);
  }

  const coalesced: SkillCandidate[] = [];
  for (const [name, candidates] of exactNames) {
    const variantsByHash = new Map<string, SkillCandidate[]>();
    for (const candidate of candidates) {
      const variant = variantsByHash.get(candidate.discoveryHash) ?? [];
      variant.push(candidate);
      variantsByHash.set(candidate.discoveryHash, variant);
    }
    if (variantsByHash.size > 1) {
      const variants = [...variantsByHash.entries()]
        .map(([hash, variants]) => ({ hash, paths: variants.map((variant) => variant.sourcePath).sort((a, b) => a.localeCompare(b)) }))
        .sort((a, b) => a.paths[0]!.localeCompare(b.paths[0]!));
      const paths = variants.flatMap((variant) => variant.paths);
      throw new SkillenvError(
        `Skill '${name}' has different variants at ${paths.join(", ")}. Rerun with --path set to one of these paths`,
        "AMBIGUOUS_SKILL_VARIANT",
        { name, variants },
      );
    }
    const preferred = [...candidates].sort((a, b) =>
      collectionPriority(a.sourcePath) - collectionPriority(b.sourcePath)
      || a.sourcePath.localeCompare(b.sourcePath));
    coalesced.push(preferred[0]!);
  }
  return coalesced;
}

function finalizeCandidates(found: readonly SkillCandidate[]): SkillCandidate[] {
  const coalesced = coalesceCandidates(found);
  const byName = new Map<string, SkillCandidate>();
  const byPathName = new Map<string, SkillCandidate>();
  for (const skill of coalesced) {
    const pathCollision = byPathName.get(skill.name.toLocaleLowerCase("en-US"));
    if (pathCollision) throw new SkillenvError(`Skill names '${pathCollision.name}' and '${skill.name}' collide on case-insensitive filesystems`, "DUPLICATE_SKILL");
    byName.set(skill.name, skill);
    byPathName.set(skill.name.toLocaleLowerCase("en-US"), skill);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name) || a.sourcePath.localeCompare(b.sourcePath));
}

async function discoverSkills(root: string, rootFallbackName?: string): Promise<SkillCandidate[]> {
  const rootSkill = await candidateAt(root, root, rootFallbackName);
  if (rootSkill) return [rootSkill];
  const directories: string[] = [];
  const canonicalRoot = await realpath(root);
  for (const collection of SKILL_COLLECTIONS) {
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
  return finalizeCandidates(found);
}

async function selectSourcePath(root: string, selectedPath: string): Promise<string> {
  let current = root;
  for (const segment of selectedPath.split("/")) {
    current = join(current, segment);
    const entry = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!entry) throw new SkillenvError(`Source path not found: ${selectedPath}`, "SOURCE_PATH_NOT_FOUND");
    if (entry.isSymbolicLink()) throw new SkillenvError(`Symbolic link source paths are not supported: ${selectedPath}`, "INVALID_SKILL");
    if (!entry.isDirectory()) throw new SkillenvError(`Source path is not a directory: ${selectedPath}`, "SOURCE_PATH_UNSUPPORTED");
  }
  const canonicalRoot = await realpath(root);
  const canonicalSelected = await realpath(current);
  if (canonicalSelected !== canonicalRoot && !canonicalSelected.startsWith(`${canonicalRoot}${sep}`)) {
    throw new SkillenvError(`Source path escapes source root: ${selectedPath}`, "INVALID_SOURCE_PATH");
  }
  return current;
}

async function discoverSelectedPath(root: string, selectedPath: string): Promise<SkillCandidate[]> {
  const selectedRoot = await selectSourcePath(root, selectedPath);
  const selectedSkill = await candidateAt(selectedRoot, root, basename(selectedRoot));
  if (selectedSkill) return [selectedSkill];
  const entries = await readdir(selectedRoot, { withFileTypes: true });
  const directories = entries.filter((entry) => entry.isDirectory()).map((entry) => join(selectedRoot, entry.name));
  const found = (await Promise.all(directories.map((directory) => candidateAt(directory, root)))).filter((skill): skill is SkillCandidate => skill !== null);
  return finalizeCandidates(found);
}

async function discoverSource(root: string, selectedPath: string | undefined, rootFallbackName?: string): Promise<SkillCandidate[]> {
  return selectedPath ? discoverSelectedPath(root, selectedPath) : discoverSkills(root, rootFallbackName);
}

export async function resolveSource(input: string, options: ResolveSourceOptions = {}): Promise<ResolvedSource> {
  const explicitPath = options.path === undefined ? undefined : normalizeSourcePath(options.path);
  const local = resolve(input);
  const localStat = await lstat(local).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (localStat?.isSymbolicLink()) throw new SkillenvError(`Symbolic link sources are not supported: ${input}`, "INVALID_SKILL");
  if (localStat?.isDirectory()) {
    const skills = await discoverSource(local, explicitPath);
    if (!skills.length) throw new SkillenvError(`No skills found in ${explicitPath ? `${input} at ${explicitPath}` : input}`, "NO_SKILLS_FOUND");
    return { input, kind: "local", root: local, selectedPath: explicitPath ?? null, revision: null, skills, cleanup: async () => {} };
  }
  if (localStat) throw new SkillenvError(`Local source is not a directory: ${input}`, "SOURCE_UNSUPPORTED");

  const remote = gitUrl(input);
  if (!remote) throw new SkillenvError(`Source is neither a local directory nor a supported Git source: ${input}`, "SOURCE_UNSUPPORTED");
  if (explicitPath && remote.path) throw new SkillenvError("Use either --path or a GitHub tree URL path, not both", "INVALID_INPUT");
  const selectedPath = explicitPath ?? remote.path;
  const temporaryRoot = await mkdtemp(join(tmpdir(), "skillenv-source-"));
  const checkout = join(temporaryRoot, "repository");
  try {
    const authentication = await prepareGitCloneAuthentication(remote.url, temporaryRoot);
    const commitRef = remote.ref && /^[0-9a-f]{40}$/i.test(remote.ref) ? remote.ref : undefined;
    const args = ["clone", "--depth", "1", "--filter=blob:none"];
    if (remote.ref && !commitRef) args.push("--branch", remote.ref);
    args.push(authentication.url, checkout);
    await execFileAsync("git", args, { encoding: "utf8", maxBuffer: 1024 * 1024, env: authentication.env });
    if (commitRef) {
      await execFileAsync("git", ["-C", checkout, "fetch", "--depth", "1", "origin", commitRef], {
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
        env: authentication.env,
      });
      await execFileAsync("git", ["-C", checkout, "checkout", "--detach", commitRef], { encoding: "utf8" });
    }
    const { stdout } = await execFileAsync("git", ["-C", checkout, "rev-parse", "HEAD"], { encoding: "utf8" });
    const repositoryName = basename(new URL(remote.url.replace(/^git@([^:]+):/, "ssh://$1/")).pathname).replace(/\.git$/, "");
    const skills = await discoverSource(checkout, selectedPath, repositoryName);
    if (!skills.length) throw new SkillenvError(`No skills found in ${selectedPath ? `${input} at ${selectedPath}` : input}`, "NO_SKILLS_FOUND");
    return {
      input,
      kind: "git",
      root: checkout,
      selectedPath: selectedPath ?? null,
      revision: stdout.trim(),
      skills,
      cleanup: () => rm(temporaryRoot, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(temporaryRoot, { recursive: true, force: true });
    if (error instanceof SkillenvError) throw error;
    const detail = (error as { stderr?: string }).stderr?.trim();
    throw new SkillenvError(`Could not fetch ${sanitizeSourceInput(input)}${detail ? `: ${sanitizeSourceText(detail)}` : ""}`, "SOURCE_UNREACHABLE");
  }
}
