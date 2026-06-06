import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AppUpdateStatusJson } from "../shared/rpc-schema";

let listener: ((status: AppUpdateStatusJson) => void) | null = null;
let lastError: string | null = null;

function readPackageVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkgPath = join(here, "..", "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as {
      version?: string;
    };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function snapshot(): AppUpdateStatusJson {
  return {
    channel: "web",
    error: lastError,
    lastCheckedAt: null,
    localHash: "",
    localVersion: readPackageVersion(),
    progress: null,
    remoteHash: null,
    remoteVersion: null,
    state: lastError === null ? "idle" : "error",
  };
}

function emit(): void {
  if (listener === null) return;
  listener(snapshot());
}

export function initAppUpdater(onStatus: (status: AppUpdateStatusJson) => void): void {
  listener = onStatus;
  emit();
}

export function stopAppUpdater(): void {
  listener = null;
}

export function getAppUpdateStatus(): AppUpdateStatusJson {
  return snapshot();
}

export async function checkForUpdate(): Promise<AppUpdateStatusJson> {
  lastError = "Self-updates are not available in the Skiller web service.";
  emit();
  return snapshot();
}

export async function downloadUpdate(): Promise<AppUpdateStatusJson> {
  lastError = "Self-updates are not available in the Skiller web service.";
  emit();
  return snapshot();
}

export async function applyUpdate(): Promise<void> {
  lastError = "Self-updates are not available in the Skiller web service.";
  emit();
}
