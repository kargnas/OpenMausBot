import { beforeEach, describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => {
  class Emitter {
    #listeners = new Map();

    on(event, listener) {
      const listeners = this.#listeners.get(event) ?? [];
      listeners.push(listener);
      this.#listeners.set(event, listeners);
      return this;
    }

    once(event, listener) {
      const wrapped = (...args) => {
        this.#listeners.set(
          event,
          (this.#listeners.get(event) ?? []).filter((candidate) => candidate !== wrapped),
        );
        listener(...args);
      };
      return this.on(event, wrapped);
    }

    emit(event, ...args) {
      for (const listener of [...(this.#listeners.get(event) ?? [])]) listener(...args);
      return true;
    }

    removeAllListeners() {
      this.#listeners.clear();
    }
  }

  const app = Object.assign(new Emitter(), {
    isPackaged: false,
    requestSingleInstanceLock: vi.fn(() => true),
    quit: vi.fn(),
    whenReady: vi.fn(() => Promise.resolve()),
    getPath: vi.fn((name) => `/tmp/openmausbot-${name}`),
    setDesktopName: vi.fn(),
    dock: { setIcon: vi.fn() },
  });

  class MockBrowserWindow extends Emitter {
    static windows = [];

    constructor() {
      super();
      this.webContents = {
        setWindowOpenHandler: vi.fn(),
        once: vi.fn(),
      };
      this.isMinimized = vi.fn(() => false);
      this.restore = vi.fn();
      this.show = vi.fn();
      this.focus = vi.fn();
      this.loadURL = vi.fn();
      this.close = vi.fn();
      MockBrowserWindow.windows.push(this);
    }

    static getAllWindows() {
      return MockBrowserWindow.windows;
    }

    static fromWebContents() {
      return null;
    }
  }

  const ipcMain = { handle: vi.fn() };
  const utilityProcess = { fork: vi.fn() };
  const session = { defaultSession: { setDisplayMediaRequestHandler: vi.fn() } };
  const desktopCapturer = { getSources: vi.fn(async () => []) };
  const shell = { openExternal: vi.fn() };
  const clipboard = { writeText: vi.fn() };
  const systemPreferences = {};

  return {
    app,
    Emitter,
    BrowserWindow: MockBrowserWindow,
    clipboard,
    desktopCapturer,
    ipcMain,
    session,
    shell,
    systemPreferences,
    utilityProcess,
  };
});

vi.mock("electron", () => electron);
vi.mock("./cua.mjs", () => ({
  registerCuaIpc: vi.fn(),
  startCua: vi.fn(async () => ({ mode: "unavailable" })),
  stopCua: vi.fn(async () => {}),
}));
vi.mock("./speech.mjs", () => ({ finishSpeech: vi.fn(), startSpeech: vi.fn(), stopSpeech: vi.fn() }));
vi.mock("./terminal-launch.mjs", () => ({ openBlankTerminal: vi.fn() }));
vi.mock("./updater.mjs", () => ({ registerUpdaterIpc: vi.fn(), startUpdater: vi.fn() }));
vi.mock("./capabilities.cjs", () => ({ default: { desktopCapabilities: vi.fn() } }));

const loadMain = async () => {
  vi.resetModules();
  return import("./main.mjs");
};

describe("Electron app lifecycle", () => {
  beforeEach(() => {
    electron.app.removeAllListeners();
    electron.app.isPackaged = false;
    electron.app.requestSingleInstanceLock.mockReset();
    electron.app.requestSingleInstanceLock.mockReturnValue(true);
    electron.app.quit.mockReset();
    electron.app.whenReady.mockReset();
    electron.app.whenReady.mockReturnValue(Promise.resolve());
    electron.utilityProcess.fork.mockReset();
    electron.BrowserWindow.windows = [];
    process.resourcesPath = "/tmp/openmausbot-resources";
  });

  it("exits a second launch before readiness or server startup", async () => {
    electron.app.requestSingleInstanceLock.mockReturnValue(false);

    await loadMain();

    expect(electron.app.quit).toHaveBeenCalledOnce();
    expect(electron.app.whenReady).not.toHaveBeenCalled();
    expect(electron.utilityProcess.fork).not.toHaveBeenCalled();
  });

  it("activates the existing window when a second instance starts", async () => {
    await loadMain();
    await new Promise((resolve) => setImmediate(resolve));

    const win = electron.BrowserWindow.getAllWindows()[0];
    win.isMinimized.mockReturnValue(true);
    electron.app.emit("second-instance");

    expect(win.restore).toHaveBeenCalledOnce();
    expect(win.show).toHaveBeenCalledOnce();
    expect(win.focus).toHaveBeenCalledOnce();
  });

  it("quits the host when the successfully started server exits", async () => {
    electron.app.isPackaged = true;
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ app: "openmausbot", pid: 123, static: true }),
    }));
    const proc = Object.assign(new electron.Emitter(), {
      pid: 123,
      stdout: new electron.Emitter(),
      stderr: new electron.Emitter(),
      kill: vi.fn(),
    });
    electron.utilityProcess.fork.mockReturnValue(proc);

    await loadMain();
    await vi.waitFor(() => expect(electron.utilityProcess.fork).toHaveBeenCalledOnce());
    proc.emit("exit", 1);

    expect(electron.app.quit).toHaveBeenCalledOnce();
  });

  it("retries when the server exits while its health body is being parsed", async () => {
    electron.app.isPackaged = true;
    let resolveFirstHealth;
    const firstHealth = new Promise((resolve) => {
      resolveFirstHealth = resolve;
    });
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: () => firstHealth })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ app: "openmausbot", pid: 456, static: true }),
      });
    const first = Object.assign(new electron.Emitter(), {
      pid: 123,
      stdout: new electron.Emitter(),
      stderr: new electron.Emitter(),
      kill: vi.fn(),
    });
    const second = Object.assign(new electron.Emitter(), {
      pid: 456,
      stdout: new electron.Emitter(),
      stderr: new electron.Emitter(),
      kill: vi.fn(),
    });
    electron.utilityProcess.fork.mockReturnValueOnce(first).mockReturnValueOnce(second);

    await loadMain();
    await vi.waitFor(() => expect(globalThis.fetch).toHaveBeenCalledOnce());
    first.emit("exit", 1);
    resolveFirstHealth({ app: "openmausbot", pid: 123, static: true });

    await vi.waitFor(() => expect(electron.utilityProcess.fork).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(electron.BrowserWindow.getAllWindows()[0]?.loadURL).toHaveBeenCalledWith(
      "http://127.0.0.1:18799",
    ));
  });

  it("does not re-quit when the server exits during intentional shutdown", async () => {
    electron.app.isPackaged = true;
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ app: "openmausbot", pid: 123, static: true }),
    }));
    const proc = Object.assign(new electron.Emitter(), {
      pid: 123,
      stdout: new electron.Emitter(),
      stderr: new electron.Emitter(),
      kill: vi.fn(),
    });
    electron.utilityProcess.fork.mockReturnValue(proc);

    await loadMain();
    await vi.waitFor(() => expect(electron.utilityProcess.fork).toHaveBeenCalledOnce());
    const beforeQuit = { preventDefault: vi.fn() };
    electron.app.emit("before-quit", beforeQuit);
    await new Promise((resolve) => setImmediate(resolve));
    proc.emit("exit", 1);
    await new Promise((resolve) => setImmediate(resolve));

    expect(beforeQuit.preventDefault).toHaveBeenCalledOnce();
    expect(electron.app.quit).toHaveBeenCalledOnce();
  });
});
