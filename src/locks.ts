import { stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";

const HEARTBEAT_INTERVAL_MS = 15_000;
const HEARTBEAT_STALE_MS = 2 * 60_000;
const LEGACY_LOCK_STALE_MS = 30 * 60_000;
const HEARTBEAT_FILE = ".heartbeat";

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

export async function lockOwnerIsActive(lockPath: string, pid: number, createdAt: number): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 0 || !processIsRunning(pid)) return false;
  const heartbeat = await stat(join(lockPath, HEARTBEAT_FILE)).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (heartbeat) return Date.now() - heartbeat.mtimeMs < HEARTBEAT_STALE_MS;
  return Number.isFinite(createdAt) && Date.now() - createdAt < LEGACY_LOCK_STALE_MS;
}

export async function startLockHeartbeat(lockPath: string): Promise<() => void> {
  const heartbeatPath = join(lockPath, HEARTBEAT_FILE);
  await writeFile(heartbeatPath, `${process.pid}\n`);
  const timer = setInterval(() => {
    const now = new Date();
    void utimes(heartbeatPath, now, now).catch(() => {});
  }, HEARTBEAT_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
