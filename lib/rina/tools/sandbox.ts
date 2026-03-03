import fs from "node:fs/promises";
import path from "node:path";

import { tool } from "ai";
import { z } from "zod";

import type { BotThread } from "../types";

// --- Constants ---

const ARTIFACTS_DIR = path.resolve("artifacts");
const SNAPSHOT_CACHE_PATH = path.resolve(".sandbox-snapshot.json");
const SANDBOX_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes
const COMMAND_TIMEOUT_MS = 90 * 1000; // 90 seconds for the python script
const MAX_OUTPUT_CHARS = 4000;

/**
 * Packages pre-installed in the snapshot image (alongside uv).
 * When the user requests only these, package install is skipped entirely.
 * When the user requests extras beyond these, only the extras are installed via uv.
 */
const SNAPSHOT_PACKAGES = [
  "matplotlib",
  "numpy",
  "pandas",
  "scipy",
  "seaborn",
  "pillow",
  "scikit-learn",
];

// --- Snapshot cache on disk ---

interface SnapshotCache {
  snapshotId: string;
  packages: string[];
  createdAt: string;
}

async function loadSnapshotCache(): Promise<SnapshotCache | null> {
  try {
    const raw = await fs.readFile(SNAPSHOT_CACHE_PATH, "utf-8");
    return JSON.parse(raw) as SnapshotCache;
  } catch {
    return null;
  }
}

async function saveSnapshotCache(cache: SnapshotCache): Promise<void> {
  await fs.writeFile(SNAPSHOT_CACHE_PATH, JSON.stringify(cache, null, 2));
}

async function clearSnapshotCache(): Promise<void> {
  try {
    await fs.unlink(SNAPSHOT_CACHE_PATH);
  } catch {
    // File may not exist — that's fine
  }
}

// --- Lazy snapshot creation (deduplicated across concurrent calls) ---

let snapshotCreationPromise: Promise<string | null> | null = null;

/**
 * Ensure a snapshot with common data-science packages exists.
 * Reads from disk cache first; creates one if needed (lazy, one-time).
 * Concurrent calls are deduplicated via a shared promise.
 */
async function ensureSnapshot(): Promise<string | null> {
  const cached = await loadSnapshotCache();
  if (cached?.snapshotId) return cached.snapshotId;

  // Deduplicate: if another call is already creating, wait on the same promise
  if (snapshotCreationPromise) return snapshotCreationPromise;

  snapshotCreationPromise = createSnapshot();
  try {
    return await snapshotCreationPromise;
  } finally {
    snapshotCreationPromise = null;
  }
}

/**
 * Spin up a throwaway sandbox, install uv + common packages, and snapshot it.
 * uv is baked into the snapshot so per-call installs use it for speed.
 * The snapshot call stops the sandbox automatically — no stop() needed.
 */
async function createSnapshot(): Promise<string | null> {
  const { Sandbox } = await import("@vercel/sandbox");

  const t0 = Date.now();
  console.log(
    `[rina:sandbox] creating snapshot with uv + ${SNAPSHOT_PACKAGES.join(", ")}`,
  );

  let sandbox: Awaited<ReturnType<typeof Sandbox.create>> | undefined;
  try {
    sandbox = await Sandbox.create({
      runtime: "python3.13",
      timeout: SANDBOX_TIMEOUT_MS,
    });

    // Install uv first (via pip), then use uv for the rest
    const uvResult = await sandbox.runCommand("pip", [
      "install",
      "--quiet",
      "uv",
    ]);

    if (uvResult.exitCode !== 0) {
      const stderr = await uvResult.stderr();
      console.error(
        `[rina:sandbox] uv install failed (exit ${uvResult.exitCode}): ${stderr.slice(0, 500)}`,
      );
      await sandbox.stop();
      return null;
    }

    console.log(`[rina:sandbox] uv installed (${elapsed(t0)})`);

    // Initialize a uv project so `uv add` has a pyproject.toml to work with
    const initResult = await sandbox.runCommand("uv", ["init", "--quiet"]);
    if (initResult.exitCode !== 0) {
      const stderr = await initResult.stderr();
      console.error(
        `[rina:sandbox] uv init failed (exit ${initResult.exitCode}): ${stderr.slice(0, 500)}`,
      );
      await sandbox.stop();
      return null;
    }

    const pkgResult = await sandbox.runCommand("uv", [
      "add",
      "--quiet",
      ...SNAPSHOT_PACKAGES,
    ]);

    if (pkgResult.exitCode !== 0) {
      const stderr = await pkgResult.stderr();
      console.error(
        `[rina:sandbox] snapshot uv install failed (exit ${pkgResult.exitCode}): ${stderr.slice(0, 500)}`,
      );
      await sandbox.stop();
      return null;
    }

    // snapshot() stops the sandbox automatically — do NOT call stop() after
    const snapshot = await sandbox.snapshot({ expiration: 0 });

    const cache: SnapshotCache = {
      snapshotId: snapshot.snapshotId,
      packages: [...SNAPSHOT_PACKAGES],
      createdAt: new Date().toISOString(),
    };
    await saveSnapshotCache(cache);

    console.log(
      `[rina:sandbox] snapshot created: ${snapshot.snapshotId} (${elapsed(t0)})`,
    );
    return snapshot.snapshotId;
  } catch (err) {
    console.error("[rina:sandbox] snapshot creation failed:", err);
    // Try to clean up if snapshot() itself threw (sandbox may still be running)
    if (sandbox) {
      try {
        await sandbox.stop();
      } catch {
        /* already stopped by snapshot or truly unreachable */
      }
    }
    return null;
  }
}

// --- Helpers ---

function elapsed(t0: number): string {
  return `${((Date.now() - t0) / 1000).toFixed(1)}s`;
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return (
    text.slice(0, maxLen) + `\n...(truncated, ${text.length} chars total)`
  );
}

// --- Tool factory ---

/**
 * Creates sandbox tools that run Python code in an isolated Vercel Sandbox
 * microVM and retrieve output files into artifacts/.
 */
export function createSandboxTools(thread: BotThread) {
  const runPythonCode = tool({
    description:
      "Execute Python code in an isolated Vercel Sandbox (microVM) with full package support. " +
      "Use this for tasks that need Python packages like matplotlib, numpy, pandas, scipy, etc. " +
      "The code runs in a fresh Python 3.13 environment. Specify any packages to install. " +
      "Common data-science packages (matplotlib, numpy, pandas, scipy, seaborn, pillow, scikit-learn) " +
      "are pre-cached and load instantly — no install delay for these. " +
      "Any files the script writes (e.g. plots, CSVs) can be retrieved by listing them in outputFiles. " +
      "Retrieved files are saved to artifacts/ and posted to chat automatically. " +
      "Do NOT call uploadArtifact afterward — files are already posted by this tool.",
    inputSchema: z.object({
      code: z
        .string()
        .describe(
          "Python code to execute. Use print() for text output. " +
            "Save files to the current working directory (e.g. plt.savefig('plot.png')). " +
            "The working directory is /vercel/sandbox.",
        ),
      packages: z
        .array(z.string())
        .optional()
        .describe(
          "Packages to install before running the code (installed via uv for speed). " +
            'Example: ["matplotlib", "numpy", "pandas"]. ' +
            "Common data-science packages are pre-cached and skip install. " +
            "Omit if no extra packages are needed.",
        ),
      outputFiles: z
        .array(z.string())
        .optional()
        .describe(
          "Filenames the script is expected to produce (relative to working directory). " +
            'Example: ["plot.png", "results.csv"]. ' +
            "These files will be downloaded to artifacts/ and posted to chat.",
        ),
    }),
    execute: async ({ code, packages, outputFiles }) => {
      const { Sandbox } = await import("@vercel/sandbox");

      let sandbox: Awaited<ReturnType<typeof Sandbox.create>> | null = null;

      try {
        const tTotal = Date.now();

        // --- 1. Create sandbox (from snapshot if available) ---
        const tCreate = Date.now();
        const snapshotId = await ensureSnapshot();
        const snapshotPkgs =
          (await loadSnapshotCache())?.packages ?? [];

        let usedSnapshot = false;

        if (snapshotId) {
          try {
            sandbox = await Sandbox.create({
              source: { type: "snapshot", snapshotId },
              timeout: SANDBOX_TIMEOUT_MS,
            });
            usedSnapshot = true;
            console.log(
              `[rina:sandbox] created from snapshot (${elapsed(tCreate)})`,
            );
          } catch (err) {
            // Snapshot expired or deleted — clear cache and fall back
            console.warn(
              `[rina:sandbox] snapshot ${snapshotId} unusable, clearing cache:`,
              err instanceof Error ? err.message : err,
            );
            await clearSnapshotCache();
          }
        }

        if (!sandbox) {
          sandbox = await Sandbox.create({
            runtime: "python3.13",
            timeout: SANDBOX_TIMEOUT_MS,
          });
          console.log(
            `[rina:sandbox] created fresh sandbox (${elapsed(tCreate)})`,
          );
        }

        // --- 2. Install packages (skip those already in snapshot) ---
        // Use uv when from snapshot (uv is baked in), fall back to pip otherwise
        const requested = packages ?? [];
        const toInstall = usedSnapshot
          ? requested.filter((p) => !snapshotPkgs.includes(p))
          : requested;

        if (toInstall.length > 0) {
          const tPkg = Date.now();
          const cmd = usedSnapshot ? "uv" : "pip";
          const args = usedSnapshot
            ? ["add", "--quiet", ...toInstall]
            : ["install", "--quiet", ...toInstall];

          console.log(
            `[rina:sandbox] ${cmd} install: ${toInstall.join(", ")}`,
          );

          const pkgResult = await sandbox.runCommand(cmd, args);

          if (pkgResult.exitCode !== 0) {
            const stderr = await pkgResult.stderr();
            return `Failed to install packages (exit ${pkgResult.exitCode}):\n${truncate(stderr, MAX_OUTPUT_CHARS)}`;
          }

          console.log(
            `[rina:sandbox] ${cmd} install done (${elapsed(tPkg)})`,
          );
        } else if (requested.length > 0) {
          console.log(
            `[rina:sandbox] all ${requested.length} packages from snapshot, skipping install`,
          );
        }

        // --- 3. Write the Python script ---
        await sandbox.writeFiles([
          { path: "script.py", content: Buffer.from(code, "utf-8") },
        ]);

        // --- 4. Run the script ---
        const tRun = Date.now();
        const controller = new AbortController();
        const timer = setTimeout(
          () => controller.abort(),
          COMMAND_TIMEOUT_MS,
        );

        // Use `uv run` when from snapshot (packages live in .venv), plain python3 otherwise
        const runCmd = usedSnapshot ? "uv" : "python3";
        const runArgs = usedSnapshot
          ? ["run", "python3", "script.py"]
          : ["script.py"];

        let result;
        try {
          result = await sandbox.runCommand(runCmd, runArgs, {
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timer);
        }

        const stdout = await result.stdout();
        const stderr = await result.stderr();

        console.log(
          `[rina:sandbox] script exit ${result.exitCode} (${elapsed(tRun)})`,
        );

        // --- 5. Retrieve output files ---
        const retrievedFiles: string[] = [];

        if (outputFiles && outputFiles.length > 0) {
          await fs.mkdir(ARTIFACTS_DIR, { recursive: true });

          for (const filename of outputFiles) {
            try {
              const buffer = await sandbox.readFileToBuffer({
                path: filename,
              });

              if (!buffer) {
                console.log(
                  `[rina:sandbox] output file not found: ${filename}`,
                );
                continue;
              }

              // Save to local artifacts/
              const localPath = path.join(
                ARTIFACTS_DIR,
                path.basename(filename),
              );
              await fs.writeFile(localPath, buffer);
              retrievedFiles.push(path.basename(filename));

              // Post to chat
              const ext = path.extname(filename).slice(1).toLowerCase();
              const mimeMap: Record<string, string> = {
                png: "image/png",
                jpg: "image/jpeg",
                jpeg: "image/jpeg",
                gif: "image/gif",
                webp: "image/webp",
                svg: "image/svg+xml",
                pdf: "application/pdf",
                csv: "text/csv",
                json: "application/json",
              };
              const mimeType = mimeMap[ext] || "application/octet-stream";

              await thread.post({
                markdown: path.basename(filename),
                files: [
                  {
                    data: buffer,
                    filename: path.basename(filename),
                    mimeType,
                  },
                ],
              });

              console.log(
                `[rina:sandbox] retrieved: ${filename} (${(buffer.length / 1024).toFixed(1)} KB)`,
              );
            } catch (err) {
              console.error(
                `[rina:sandbox] failed to retrieve ${filename}:`,
                err,
              );
            }
          }
        }

        // --- 6. Build result for the LLM ---
        const parts: string[] = [];

        if (result.exitCode !== 0) {
          parts.push(`Script exited with code ${result.exitCode}.`);
        } else {
          parts.push("Script executed successfully.");
        }

        if (stdout.trim()) {
          parts.push(`stdout:\n${truncate(stdout, MAX_OUTPUT_CHARS)}`);
        }

        if (stderr.trim()) {
          parts.push(`stderr:\n${truncate(stderr, MAX_OUTPUT_CHARS)}`);
        }

        if (retrievedFiles.length > 0) {
          parts.push(
            `Retrieved files: ${retrievedFiles.join(", ")} (saved to artifacts/ and posted to chat)`,
          );
        } else if (outputFiles && outputFiles.length > 0) {
          parts.push(
            "Warning: none of the expected output files were found. " +
              "Check that the script writes files to the current directory.",
          );
        }

        console.log(
          `[rina:sandbox] total execution time: ${elapsed(tTotal)}`,
        );

        return parts.join("\n\n");
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);
        console.error(
          `[rina:sandbox] runPythonCode failed: ${message}`,
          error,
        );
        return `Sandbox execution failed: ${message}`;
      } finally {
        if (sandbox) {
          try {
            await sandbox.stop();
            console.log("[rina:sandbox] sandbox stopped");
          } catch {
            // May already be stopped — safe to ignore
          }
        }
      }
    },
  });

  return { runPythonCode };
}
