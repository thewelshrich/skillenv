import { isAbsolute, join } from "node:path";
import { listEnvironments } from "./environments.js";
import { SkillenvError } from "./errors.js";
import { hashDirectory } from "./fs.js";
import { inspectLibrary, installLibrarySkills, listSkills, readSkillMetadata, requireSkill } from "./library.js";
import { libraryDir } from "./paths.js";
import type { SkillMetadata } from "./schema.js";
import { fetchSource, findSkillAtSourcePath, type FetchedSource, type SkillCandidate } from "./sources.js";

export interface UpdateRequest {
  skills?: string[];
  force?: boolean;
  dryRun?: boolean;
}

export type SkillUpdate =
  | { name: string; status: "updated"; from: string | null; to: string | null }
  | { name: string; status: "current" }
  | { name: string; status: "skipped" | "failed"; reason: string };

export interface UpdateResult {
  dryRun: boolean;
  skills: SkillUpdate[];
  environments: string[];
}

interface Tracked {
  name: string;
  metadata: SkillMetadata;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function trackedSkills(names: readonly string[], force: boolean, outcomes: Map<string, SkillUpdate>): Promise<Tracked[]> {
  const tracked: Tracked[] = [];
  for (const name of names) {
    const metadata = await readSkillMetadata(name).catch((error) => {
      outcomes.set(name, { name, status: "failed", reason: message(error) });
      return undefined;
    });
    if (metadata === undefined) continue;
    if (!metadata) {
      outcomes.set(name, { name, status: "skipped", reason: "no recorded source; reinstall it with skillenv add" });
      continue;
    }
    if (metadata.sourceKind === "local" && !isAbsolute(metadata.source)) {
      outcomes.set(name, { name, status: "skipped", reason: `local source was recorded as a relative path (${metadata.source}); reinstall it with skillenv add` });
      continue;
    }
    const libraryHash = await hashDirectory(join(libraryDir(), name)).catch((error) => {
      outcomes.set(name, { name, status: "failed", reason: message(error) });
      return undefined;
    });
    if (libraryHash === undefined) continue;
    if (!force && libraryHash !== metadata.hash) {
      outcomes.set(name, { name, status: "skipped", reason: "modified in your library; use --force to discard local changes" });
      continue;
    }
    tracked.push({ name, metadata });
  }
  return tracked;
}

async function updateFromSource(source: FetchedSource, group: readonly Tracked[], dryRun: boolean, outcomes: Map<string, SkillUpdate>): Promise<void> {
  const candidates: Array<{ entry: Tracked; candidate: SkillCandidate }> = [];
  for (const entry of group) {
    const candidate = await findSkillAtSourcePath(source, entry.metadata.sourcePath, entry.name);
    if (!candidate) {
      outcomes.set(entry.name, { name: entry.name, status: "failed", reason: `no longer found at ${entry.metadata.sourcePath} in ${entry.metadata.source}` });
    } else if (candidate.name !== entry.name) {
      outcomes.set(entry.name, { name: entry.name, status: "failed", reason: `renamed to '${candidate.name}' upstream; install it with skillenv add` });
    } else {
      candidates.push({ entry, candidate });
    }
  }
  if (!candidates.length) return;

  const inspection = await inspectLibrary(candidates.map(({ candidate }) => candidate));
  const changed = new Set(inspection.conflicts);
  // Content that is unchanged still gets fresh metadata when the source moved to a new revision.
  const toWrite = candidates.filter(({ entry, candidate }) => changed.has(candidate.name) || entry.metadata.revision !== source.revision);
  for (const { entry, candidate } of candidates) {
    outcomes.set(entry.name, changed.has(candidate.name)
      ? { name: entry.name, status: "updated", from: entry.metadata.revision, to: source.revision }
      : { name: entry.name, status: "current" });
  }
  if (dryRun || !toWrite.length) return;

  const change = await installLibrarySkills(
    toWrite.map(({ candidate }) => candidate),
    { input: group[0]!.metadata.source, kind: source.kind, revision: source.revision },
    {
      replace: true,
      allowedConflicts: inspection.conflicts,
      approvedState: Object.fromEntries(toWrite.map(({ candidate }) => [candidate.name, {
        skill: inspection.existingFingerprints[candidate.name] ?? null,
        metadata: inspection.metadataFingerprints[candidate.name] ?? null,
      }])),
    },
  );
  try {
    await change.finalize();
  } catch (error) {
    await change.rollback().catch(() => {});
    throw error;
  }
}

export async function update(request: UpdateRequest = {}): Promise<UpdateResult> {
  const names = request.skills?.length ? [...new Set(request.skills)] : await listSkills();
  for (const name of names) await requireSkill(name);
  const outcomes = new Map<string, SkillUpdate>();
  const tracked = await trackedSkills(names, request.force ?? false, outcomes);

  const groups = new Map<string, Tracked[]>();
  for (const entry of tracked) groups.set(entry.metadata.source, [...(groups.get(entry.metadata.source) ?? []), entry]);
  for (const [input, group] of groups) {
    let source: FetchedSource | null = null;
    try {
      source = await fetchSource(input);
      await updateFromSource(source, group, request.dryRun ?? false, outcomes);
    } catch (error) {
      if (error instanceof SkillenvError && error.code === "RECOVERY_REQUIRED") throw error;
      for (const entry of group) {
        if (outcomes.get(entry.name)?.status !== "failed") outcomes.set(entry.name, { name: entry.name, status: "failed", reason: message(error) });
      }
    } finally {
      await source?.cleanup().catch(() => {});
    }
  }

  const skills = names.map((name) => outcomes.get(name)!);
  const updated = new Set(skills.filter((skill) => skill.status === "updated").map((skill) => skill.name));
  const environments = updated.size
    ? (await listEnvironments()).filter((environment) => environment.skills.some((skill) => updated.has(skill))).map((environment) => environment.name)
    : [];
  return { dryRun: request.dryRun ?? false, skills, environments };
}
