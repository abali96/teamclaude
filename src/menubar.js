// Native macOS menu-bar companion — `teamclaude menubar install`.
//
// The source ships with the npm package and is compiled on the user's Mac. This
// keeps the package architecture-independent and avoids checking in an opaque
// executable. The app is a separate LaunchAgent from the proxy: quitting it has
// no effect on requests or Claude sessions.

import { spawnSync } from 'node:child_process';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MENUBAR_LABEL = 'com.karpeleslab.teamclaude.menubar';
export const MENUBAR_BINARY = 'TeamClaudeMenuBar';

const SOURCE_PATH = fileURLToPath(new URL('./menubar/TeamClaudeMenuBar.swift', import.meta.url));
/** @param {unknown} value */
const xmlEscape = (value) => String(value)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const guiDomain = (uid = process.getuid?.() ?? 0) => `gui/${uid}`;

export function menubarKind(platform = process.platform) {
  return platform === 'darwin' ? 'launchd' : null;
}

export function menubarInstallDir(home = homedir()) {
  return join(home, 'Library', 'Application Support', 'TeamClaude');
}

export function menubarBinaryPath(home = homedir()) {
  return join(menubarInstallDir(home), MENUBAR_BINARY);
}

export function menubarLaunchAgentPath(home = homedir()) {
  return join(home, 'Library', 'LaunchAgents', `${MENUBAR_LABEL}.plist`);
}

export function menubarLogPath(home = homedir()) {
  return join(home, 'Library', 'Logs', 'teamclaude-menubar.log');
}

/** @param {{binary: string, port: number, proxyLog: string, log: string}} options */
export function renderMenubarLaunchAgent({
  binary, port, proxyLog, log,
}) {
  const args = [binary, '--port', String(port), '--proxy-log', proxyLog];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${MENUBAR_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args.map(a => `    <string>${xmlEscape(a)}</string>`).join('\n')}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>LimitLoadToSessionType</key>
  <string>Aqua</string>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>StandardOutPath</key>
  <string>${xmlEscape(log)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(log)}</string>
</dict>
</plist>
`;
}

/**
 * Run a command without a shell, returning a small serializable result.
 * @param {string} cmd
 * @param {string[]} args
 */
function runCommand(cmd, args) {
  const result = spawnSync(cmd, args, { encoding: 'utf8' });
  return {
    code: result.status ?? 1,
    stdout: result.stdout || '',
    stderr: result.stderr || result.error?.message || '',
  };
}

/** @param {number} ms */
const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

export async function installMenubar({
  kind = menubarKind(), platform = process.platform, home = homedir(), port = 3456,
  proxyLog = join(home, 'Library', 'Logs', 'teamclaude.log'),
  source = SOURCE_PATH, run = runCommand, log = console.log,
  pause = wait,
} = {}) {
  if (!kind) return { ok: false, error: `The menu-bar app requires macOS (running on ${platform})` };

  const compiler = run('xcrun', ['--find', 'swiftc']);
  if (compiler.code !== 0 || !compiler.stdout.trim()) {
    return {
      ok: false,
      error: 'Swift compiler not found. Install Apple Command Line Tools with: xcode-select --install',
    };
  }

  const installDir = menubarInstallDir(home);
  const binary = menubarBinaryPath(home);
  const plist = menubarLaunchAgentPath(home);
  const appLog = menubarLogPath(home);
  const temporary = `${binary}.new-${process.pid}`;

  await mkdir(installDir, { recursive: true });
  await mkdir(dirname(plist), { recursive: true });
  await mkdir(dirname(appLog), { recursive: true });

  // Invoke through xcrun rather than calling the path it reports directly.
  // On newer Xcode/Command Line Tools combinations xcrun supplies the active
  // SDK context; the bare compiler path can otherwise fail to load the standard
  // library for the current macOS target.
  const build = run('xcrun', ['swiftc',
    '-O', '-parse-as-library', '-framework', 'AppKit', '-framework', 'Foundation',
    source, '-o', temporary,
  ]);
  if (build.code !== 0) {
    await rm(temporary, { force: true });
    const detail = build.stderr.trim() || build.stdout.trim() || `swiftc exited ${build.code}`;
    return { ok: false, error: `Could not compile the menu-bar app: ${detail}` };
  }

  await chmod(temporary, 0o755);
  await rename(temporary, binary);
  await writeFile(plist, renderMenubarLaunchAgent({
    binary, port, proxyLog, log: appLog,
  }), { mode: 0o644 });

  // Reload so reinstall also picks up a new binary, proxy port, or plist.
  run('launchctl', ['bootout', `${guiDomain()}/${MENUBAR_LABEL}`]);
  let boot = run('launchctl', ['bootstrap', guiDomain(), plist]);
  // `bootout` can return before launchd has fully removed a running process.
  // A bootstrap in that short window fails with the otherwise-unhelpful error
  // 5. Retry briefly; permanent plist or permission errors still come back.
  for (const delay of [100, 300, 600]) {
    if (boot.code === 0) break;
    await pause(delay);
    boot = run('launchctl', ['bootstrap', guiDomain(), plist]);
  }
  if (boot.code !== 0) {
    return {
      ok: false,
      error: boot.stderr.trim() || `launchctl bootstrap exited ${boot.code}`,
      binary, file: plist,
    };
  }
  // RunAtLoad may be scheduled rather than started immediately after a fresh
  // bootstrap. Kick it once so a successful install means the status item is
  // visible before the command returns. With no KeepAlive, Quit still sticks.
  const kick = run('launchctl', ['kickstart', '-k', `${guiDomain()}/${MENUBAR_LABEL}`]);
  if (kick.code !== 0) {
    return {
      ok: false,
      error: kick.stderr.trim() || `launchctl kickstart exited ${kick.code}`,
      binary, file: plist,
    };
  }

  log(`[TeamClaude] Menu bar installed: ${binary}`);
  log(`[TeamClaude] Menu bar logs: ${appLog}`);
  return { ok: true, binary, file: plist, logFile: appLog };
}

export async function uninstallMenubar({
  kind = menubarKind(), home = homedir(), run = runCommand, log = console.log,
} = {}) {
  if (!kind) return { ok: false, error: 'The menu-bar app requires macOS' };
  const binary = menubarBinaryPath(home);
  const plist = menubarLaunchAgentPath(home);
  run('launchctl', ['bootout', `${guiDomain()}/${MENUBAR_LABEL}`]);
  await rm(plist, { force: true });
  await rm(binary, { force: true });
  log(`[TeamClaude] Menu bar removed: ${binary}`);
  return { ok: true, binary, file: plist };
}

export async function menubarStatus({
  kind = menubarKind(), home = homedir(), run = runCommand,
} = {}) {
  if (!kind) return { installed: false, running: false, detail: 'unsupported platform' };
  const binary = menubarBinaryPath(home);
  const file = menubarLaunchAgentPath(home);
  const installed = existsSync(binary) && existsSync(file);
  const result = run('launchctl', ['print', `${guiDomain()}/${MENUBAR_LABEL}`]);
  const pid = /\bpid = (\d+)/.exec(result.stdout)?.[1] || null;
  return {
    installed,
    running: result.code === 0 && !!pid,
    pid,
    binary,
    file,
    detail: result.code === 0 ? 'loaded' : 'not loaded',
  };
}

export function renderMenubar({
  home = homedir(), port = 3456,
  proxyLog = join(home, 'Library', 'Logs', 'teamclaude.log'),
} = {}) {
  return renderMenubarLaunchAgent({
    binary: menubarBinaryPath(home), port, proxyLog, log: menubarLogPath(home),
  });
}

export async function readInstalledMenubar({ home = homedir() } = {}) {
  return readFile(menubarLaunchAgentPath(home), 'utf8').catch(() => null);
}
