#!/usr/bin/env node
import { spawn } from "node:child_process";
import { watch } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const serverEntry = join(root, "server", "index.ts");
const viteEntry = join(root, "node_modules", "vite", "bin", "vite.js");
const electronEntry = join(root, "node_modules", "electron", "cli.js");
const children = new Set();
let server = null;
let serverRestartTimer = null;
let fileRestartTimer = null;
let stopping = false;

function run(args) {
  const child = spawn(process.execPath, args, { cwd: root, env: process.env, stdio: "inherit" });
  children.add(child);
  child.once("exit", () => children.delete(child));
  return child;
}

function startServer() {
  if (stopping) return;
  const child = run(["--experimental-strip-types", serverEntry]);
  server = child;
  child.once("exit", (code, signal) => {
    if (server === child) server = null;
    if (stopping) return;
    console.error(`[dev] server exited (${signal ?? code}); restarting`);
    serverRestartTimer = setTimeout(startServer, 500);
  });
}

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  clearTimeout(serverRestartTimer);
  clearTimeout(fileRestartTimer);
  serverWatcher.close();
  for (const child of children) child.kill("SIGTERM");
  process.exitCode = code;
  setTimeout(() => process.exit(code), 2_000).unref();
}

async function waitFor(url, label) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Startup races are expected while the child binds its port.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${label} did not become ready at ${url}`);
}

startServer();
const serverWatcher = watch(join(root, "server"), { recursive: true }, () => {
  clearTimeout(fileRestartTimer);
  fileRestartTimer = setTimeout(() => server?.kill("SIGTERM"), 150);
});
const vite = run([viteEntry]);
vite.once("exit", (code) => {
  if (!stopping) stop(code || 1);
});

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.once(signal, () => stop());

try {
  await Promise.all([
    waitFor("http://127.0.0.1:8799/api/health", "server"),
    waitFor("http://127.0.0.1:5199", "Vite"),
  ]);
  const electron = run([electronEntry, root]);
  electron.once("exit", (code) => stop(code ?? 1));
} catch (error) {
  console.error(`[dev] ${error instanceof Error ? error.message : String(error)}`);
  stop(1);
}
