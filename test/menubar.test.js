import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MENUBAR_LABEL, menubarKind, menubarBinaryPath, menubarLaunchAgentPath,
  menubarLogPath, renderMenubarLaunchAgent, installMenubar, uninstallMenubar,
  menubarStatus,
} from '../src/menubar.js';

function recorder(handler = () => ({ code: 0, stdout: '', stderr: '' })) {
  const calls = [];
  const run = (cmd, args) => {
    calls.push([cmd, ...args]);
    return handler(cmd, args);
  };
  return { run, calls };
}

test('menu-bar integration is macOS only and uses per-user paths', () => {
  assert.equal(menubarKind('darwin'), 'launchd');
  assert.equal(menubarKind('linux'), null);
  assert.equal(menubarBinaryPath('/Users/x'), '/Users/x/Library/Application Support/TeamClaude/TeamClaudeMenuBar');
  assert.equal(menubarLaunchAgentPath('/Users/x'), `/Users/x/Library/LaunchAgents/${MENUBAR_LABEL}.plist`);
  assert.equal(menubarLogPath('/Users/x'), '/Users/x/Library/Logs/teamclaude-menubar.log');
});

test('menu-bar LaunchAgent starts in Aqua but does not restart after Quit', () => {
  const plist = renderMenubarLaunchAgent({
    binary: '/Applications/T&C/<Menu>', port: 4567,
    proxyLog: '/Users/x/Library/Logs/teamclaude.log', log: '/Users/x/Library/Logs/menu.log',
  });
  assert.match(plist, /com\.karpeleslab\.teamclaude\.menubar/);
  assert.match(plist, /<string>--port<\/string>\s*<string>4567<\/string>/);
  assert.match(plist, /<key>LimitLoadToSessionType<\/key>\s*<string>Aqua<\/string>/);
  assert.doesNotMatch(plist, /KeepAlive/);
  assert.match(plist, /T&amp;C\/&lt;Menu&gt;/);
});

test('install compiles the bundled source, writes the plist, and bootstraps it', async () => {
  const home = await mkdtemp(join(tmpdir(), 'tc-menubar-'));
  const source = join(home, 'Menu.swift');
  await writeFile(source, 'print("test")');
  try {
    const { run, calls } = recorder((cmd, args) => {
      if (cmd === 'xcrun' && args[0] === 'swiftc') {
        writeFileSync(args.at(-1), 'compiled');
        return { code: 0, stdout: '', stderr: '' };
      }
      if (cmd === 'xcrun') return { code: 0, stdout: '/usr/bin/swiftc\n', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    });
    const result = await installMenubar({
      home, platform: 'darwin', kind: 'launchd', port: 4567, source,
      run, log: () => {}, proxyLog: '/proxy.log',
    });
    assert.equal(result.ok, true);
    assert.equal(await readFile(menubarBinaryPath(home), 'utf8'), 'compiled');
    assert.match(await readFile(menubarLaunchAgentPath(home), 'utf8'), /4567/);
    assert.equal(calls[0][0], 'xcrun');
    assert.deepEqual(calls[1].slice(0, 2), ['xcrun', 'swiftc']);
    assert.match(calls[2].join(' '), /launchctl bootout gui\/\d+\/com\.karpeleslab\.teamclaude\.menubar$/);
    assert.equal(calls[3][1], 'bootstrap');
    assert.match(calls[4].join(' '), /launchctl kickstart -k gui\/\d+\/com\.karpeleslab\.teamclaude\.menubar$/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('install reports a missing toolchain before writing system state', async () => {
  const { run, calls } = recorder(() => ({ code: 1, stdout: '', stderr: 'not found' }));
  const result = await installMenubar({ kind: 'launchd', platform: 'darwin', run, log: () => {} });
  assert.equal(result.ok, false);
  assert.match(result.error, /xcode-select --install/);
  assert.equal(calls.length, 1);
});

test('install retries bootstrap while launchd finishes unloading the old job', async () => {
  const home = await mkdtemp(join(tmpdir(), 'tc-menubar-'));
  const source = join(home, 'Menu.swift');
  await writeFile(source, 'print("test")');
  let bootstraps = 0;
  try {
    const { run } = recorder((cmd, args) => {
      if (cmd === 'xcrun' && args[0] === 'swiftc') {
        writeFileSync(args.at(-1), 'compiled');
        return { code: 0, stdout: '', stderr: '' };
      }
      if (cmd === 'xcrun') return { code: 0, stdout: '/usr/bin/swiftc\n', stderr: '' };
      if (cmd === 'launchctl' && args[0] === 'bootstrap') {
        bootstraps++;
        return bootstraps === 1
          ? { code: 5, stdout: '', stderr: 'Bootstrap failed: 5' }
          : { code: 0, stdout: '', stderr: '' };
      }
      return { code: 0, stdout: '', stderr: '' };
    });
    const result = await installMenubar({
      home, platform: 'darwin', kind: 'launchd', source, run,
      pause: async () => {}, log: () => {},
    });
    assert.equal(result.ok, true);
    assert.equal(bootstraps, 2);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('uninstall unloads the agent and removes the binary and plist', async () => {
  const home = await mkdtemp(join(tmpdir(), 'tc-menubar-'));
  try {
    await mkdir(join(home, 'Library', 'Application Support', 'TeamClaude'), { recursive: true });
    await mkdir(join(home, 'Library', 'LaunchAgents'), { recursive: true });
    await writeFile(menubarBinaryPath(home), 'binary');
    await writeFile(menubarLaunchAgentPath(home), 'plist');
    const { run, calls } = recorder();
    const result = await uninstallMenubar({ kind: 'launchd', home, run, log: () => {} });
    assert.equal(result.ok, true);
    assert.match(calls[0].join(' '), /launchctl bootout/);
    await assert.rejects(readFile(menubarBinaryPath(home)));
    await assert.rejects(readFile(menubarLaunchAgentPath(home)));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('status distinguishes installed, loaded, and running', async () => {
  const home = await mkdtemp(join(tmpdir(), 'tc-menubar-'));
  try {
    await mkdir(join(home, 'Library', 'Application Support', 'TeamClaude'), { recursive: true });
    await mkdir(join(home, 'Library', 'LaunchAgents'), { recursive: true });
    await writeFile(menubarBinaryPath(home), 'binary');
    await writeFile(menubarLaunchAgentPath(home), 'plist');
    const running = recorder(() => ({ code: 0, stdout: 'state = running\n pid = 91\n', stderr: '' }));
    const status = await menubarStatus({ kind: 'launchd', home, run: running.run });
    assert.equal(status.installed, true);
    assert.equal(status.running, true);
    assert.equal(status.pid, '91');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
