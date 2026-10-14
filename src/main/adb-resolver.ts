import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawnSync } from 'child_process';
import { getAugmentedEnv } from './python-resolver';

export interface ADBCandidateCheck {
  path: string;
  exists: boolean;
  executable: boolean;
  version?: string;
  error?: string;
}

export interface ADBDiagnosticInfo {
  resolvedAdb: string | null;
  resolvedVersion: string | null;
  candidatesChecked: ADBCandidateCheck[];
  augmentedPath: string;
}

let cachedAdbPath: string | null = null;
let cachedAdbVersion: string | null = null;

/**
 * Returns an ordered list of candidate paths to check for the adb binary.
 */
function getAdbCandidatePaths(): string[] {
  const candidates: string[] = [];
  const exeName = process.platform === 'win32' ? 'adb.exe' : 'adb';
  const home = os.homedir();

  // 1. Explicit user override from environment
  if (process.env.ADB_PATH) candidates.push(process.env.ADB_PATH);
  if (process.env.NEO_ADB_PATH) candidates.push(process.env.NEO_ADB_PATH);

  // 2. Android SDK standard environment variables
  if (process.env.ANDROID_HOME) {
    candidates.push(path.join(process.env.ANDROID_HOME, 'platform-tools', exeName));
  }
  if (process.env.ANDROID_SDK_ROOT) {
    candidates.push(path.join(process.env.ANDROID_SDK_ROOT, 'platform-tools', exeName));
  }

  if (process.platform === 'darwin') {
    // macOS Homebrew (Apple Silicon & Intel)
    candidates.push('/opt/homebrew/bin/adb');
    candidates.push('/usr/local/bin/adb');

    // Android Studio default SDK location on macOS
    candidates.push(path.join(home, 'Library', 'Android', 'sdk', 'platform-tools', 'adb'));
    candidates.push('/Library/Android/sdk/platform-tools/adb');

    // User home managers / local bin
    candidates.push(path.join(home, '.android', 'platform-tools', 'adb'));
    candidates.push(path.join(home, '.local', 'bin', 'adb'));

    // Standard POSIX paths
    candidates.push('/usr/bin/adb');
    candidates.push('/bin/adb');
    candidates.push('adb');
  } else if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA;
    if (localAppData) {
      candidates.push(path.join(localAppData, 'Android', 'Sdk', 'platform-tools', 'adb.exe'));
    }
    const progFiles = process.env['ProgramFiles'];
    if (progFiles) {
      candidates.push(path.join(progFiles, 'Android', 'platform-tools', 'adb.exe'));
    }
    candidates.push('adb.exe');
    candidates.push('adb');
  } else {
    // Linux and other POSIX
    candidates.push('/usr/bin/adb');
    candidates.push('/usr/local/bin/adb');
    candidates.push(path.join(home, 'Android', 'Sdk', 'platform-tools', 'adb'));
    candidates.push(path.join(home, '.local', 'bin', 'adb'));
    candidates.push('adb');
  }

  // Deduplicate
  return Array.from(new Set(candidates));
}

/**
 * Tests whether a specific candidate is a working ADB binary.
 */
function testAdbCandidate(candidate: string, env: NodeJS.ProcessEnv): { success: boolean; version?: string; error?: string } {
  try {
    const isNamedCommand = !candidate.includes(path.sep);
    if (!isNamedCommand && !fs.existsSync(candidate)) {
      return { success: false, error: 'File does not exist on disk' };
    }

    const res = spawnSync(candidate, ['version'], {
      env,
      timeout: 3000,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe']
    });

    if (res.error) {
      return { success: false, error: res.error.message };
    }

    const output = ((res.stdout || '') + (res.stderr || '')).trim();
    if (res.status === 0 && output.toLowerCase().includes('android debug bridge')) {
      const firstLine = output.split('\n')[0].trim();
      return { success: true, version: firstLine };
    }

    return {
      success: false,
      error: `Exited with code ${res.status}: ${output || 'No output'}`
    };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

/**
 * Resolves the working ADB executable on the system, caching the result.
 */
export function resolveAdbCommand(forceRefresh = false): { command: string; version: string } | null {
  if (!forceRefresh && cachedAdbPath && cachedAdbVersion) {
    return { command: cachedAdbPath, version: cachedAdbVersion };
  }

  const env = getAugmentedEnv();
  const candidates = getAdbCandidatePaths();

  for (const candidate of candidates) {
    const testResult = testAdbCandidate(candidate, env);
    if (testResult.success) {
      cachedAdbPath = candidate;
      cachedAdbVersion = testResult.version || 'Android Debug Bridge';
      return { command: candidate, version: cachedAdbVersion };
    }
  }

  return null;
}

/**
 * Gathers detailed diagnostic info about all ADB candidates probed.
 */
export function getAdbDiagnostics(): ADBDiagnosticInfo {
  const env = getAugmentedEnv();
  const candidates = getAdbCandidatePaths();
  const tested: ADBCandidateCheck[] = [];
  let foundCommand: string | null = null;
  let foundVersion: string | null = null;

  for (const candidate of candidates) {
    const testResult = testAdbCandidate(candidate, env);
    tested.push({
      path: candidate,
      exists: !candidate.includes(path.sep) || fs.existsSync(candidate),
      executable: testResult.success,
      version: testResult.version,
      error: testResult.error
    });

    if (testResult.success && !foundCommand) {
      foundCommand = candidate;
      foundVersion = testResult.version || null;
    }
  }

  return {
    resolvedAdb: foundCommand,
    resolvedVersion: foundVersion,
    candidatesChecked: tested,
    augmentedPath: env.PATH || ''
  };
}
