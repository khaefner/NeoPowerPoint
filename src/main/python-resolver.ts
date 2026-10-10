import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawnSync } from 'child_process';

export interface PythonCandidateCheck {
  path: string;
  exists: boolean;
  executable: boolean;
  version?: string;
  error?: string;
}

export interface PythonDiagnosticInfo {
  resolvedPython: string | null;
  resolvedVersion: string | null;
  candidatesChecked: PythonCandidateCheck[];
  augmentedPath: string;
}

let cachedPythonPath: string | null = null;
let cachedPythonVersion: string | null = null;

/**
 * Returns an augmented environment object ensuring common macOS / Linux binary paths
 * (such as Homebrew, /usr/local/bin, /usr/bin) are included in PATH.
 */
export function getAugmentedEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const currentPath = env.PATH || '';
  const delimiter = path.delimiter;
  const currentEntries = currentPath.split(delimiter).filter(Boolean);

  const additionalEntries: string[] = [];

  if (process.platform === 'darwin') {
    additionalEntries.push(
      '/opt/homebrew/bin',
      '/opt/homebrew/sbin',
      '/usr/local/bin',
      '/usr/local/sbin',
      path.join(os.homedir(), 'Library/Android/sdk/platform-tools'),
      '/Library/Android/sdk/platform-tools',
      path.join(os.homedir(), '.android/platform-tools'),
      '/Library/Frameworks/Python.framework/Versions/Current/bin',
      '/usr/bin',
      '/bin',
      '/usr/sbin',
      '/sbin'
    );
  } else if (process.platform === 'linux') {
    additionalEntries.push(
      '/usr/local/bin',
      '/usr/bin',
      '/bin',
      path.join(os.homedir(), 'Android/Sdk/platform-tools'),
      path.join(os.homedir(), '.local', 'bin')
    );
  }

  // Prepend missing entries
  for (const entry of additionalEntries) {
    if (!currentEntries.includes(entry) && fs.existsSync(entry)) {
      currentEntries.unshift(entry);
    }
  }

  env.PATH = currentEntries.join(delimiter);
  return env;
}

/**
 * Generates an ordered list of candidate paths to check for Python 3.
 */
function getPythonCandidatePaths(): string[] {
  const candidates: string[] = [];

  // 1. Explicit user override from environment
  if (process.env.PYTHON_PATH) candidates.push(process.env.PYTHON_PATH);
  if (process.env.NEO_PYTHON_PATH) candidates.push(process.env.NEO_PYTHON_PATH);

  const home = os.homedir();

  if (process.platform === 'darwin') {
    // macOS Apple Silicon & Intel Homebrew
    candidates.push('/opt/homebrew/bin/python3');
    candidates.push('/usr/local/bin/python3');
    candidates.push('/opt/homebrew/bin/python');
    candidates.push('/usr/local/bin/python');

    // Official Python installer frameworks (/Library/Frameworks/Python.framework/Versions/*/bin/python3)
    const fwPath = '/Library/Frameworks/Python.framework/Versions';
    if (fs.existsSync(fwPath)) {
      try {
        const versions = fs.readdirSync(fwPath).sort().reverse();
        for (const ver of versions) {
          const binPath = path.join(fwPath, ver, 'bin', 'python3');
          candidates.push(binPath);
        }
      } catch (_) {}
    }

    // User home directory managers (pyenv, conda, miniconda, miniforge, etc.)
    candidates.push(path.join(home, '.pyenv/shims/python3'));
    candidates.push(path.join(home, 'miniconda3/bin/python3'));
    candidates.push(path.join(home, 'anaconda3/bin/python3'));
    candidates.push(path.join(home, 'miniforge3/bin/python3'));
    candidates.push(path.join(home, '.local/bin/python3'));

    // System python
    candidates.push('/usr/bin/python3');
    candidates.push('/bin/python3');
    candidates.push('python3');
    candidates.push('python');
  } else if (process.platform === 'win32') {
    candidates.push('python');
    candidates.push('py');
    candidates.push('python3');

    const localAppData = process.env.LOCALAPPDATA;
    if (localAppData) {
      const pyBase = path.join(localAppData, 'Programs', 'Python');
      if (fs.existsSync(pyBase)) {
        try {
          const dirs = fs.readdirSync(pyBase).sort().reverse();
          for (const d of dirs) {
            candidates.push(path.join(pyBase, d, 'python.exe'));
          }
        } catch (_) {}
      }
    }
  } else {
    // Linux and other POSIX
    candidates.push('/usr/bin/python3');
    candidates.push('/usr/local/bin/python3');
    candidates.push('/bin/python3');
    candidates.push(path.join(home, '.local/bin/python3'));
    candidates.push(path.join(home, '.pyenv/shims/python3'));
    candidates.push(path.join(home, 'miniconda3/bin/python3'));
    candidates.push(path.join(home, 'anaconda3/bin/python3'));
    candidates.push('python3');
    candidates.push('python');
  }

  // Deduplicate preserving order
  return Array.from(new Set(candidates));
}

/**
 * Tests whether a specific candidate is a working Python 3 binary by invoking `--version`.
 */
function testPythonCandidate(candidate: string, env: NodeJS.ProcessEnv): { success: boolean; version?: string; error?: string } {
  try {
    const isNamedCommand = !candidate.includes(path.sep);
    if (!isNamedCommand && !fs.existsSync(candidate)) {
      return { success: false, error: 'File does not exist on disk' };
    }

    const res = spawnSync(candidate, ['--version'], {
      env,
      timeout: 3000,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe']
    });

    if (res.error) {
      return { success: false, error: res.error.message };
    }

    const output = ((res.stdout || '') + (res.stderr || '')).trim();
    if (res.status === 0 && output) {
      return { success: true, version: output };
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
 * Resolves the best available working Python 3 executable on the system.
 */
export function resolvePythonCommand(forceRefresh = false): { command: string; version: string } {
  if (!forceRefresh && cachedPythonPath && cachedPythonVersion) {
    return { command: cachedPythonPath, version: cachedPythonVersion };
  }

  const env = getAugmentedEnv();
  const candidates = getPythonCandidatePaths();
  const tested: PythonCandidateCheck[] = [];

  for (const candidate of candidates) {
    const testResult = testPythonCandidate(candidate, env);
    tested.push({
      path: candidate,
      exists: !candidate.includes(path.sep) || fs.existsSync(candidate),
      executable: testResult.success,
      version: testResult.version,
      error: testResult.error
    });

    if (testResult.success) {
      cachedPythonPath = candidate;
      cachedPythonVersion = testResult.version || 'Python 3';
      return { command: candidate, version: cachedPythonVersion };
    }
  }

  const failureDetails = tested.map((t) => ` - ${t.path}: ${t.error || 'Unavailable'}`).join('\n');
  throw new Error(
    `Python 3 could not be found on this system.\n` +
    `NeoPowerPoint checked the following locations:\n${failureDetails}\n\n` +
    `Please install Python 3 (e.g. from python.org or "brew install python3" on macOS), ` +
    `or configure the PYTHON_PATH environment variable.`
  );
}

/**
 * Gathers detailed diagnostic info about all Python candidates probed.
 */
export function getPythonDiagnostics(): PythonDiagnosticInfo {
  const env = getAugmentedEnv();
  const candidates = getPythonCandidatePaths();
  const tested: PythonCandidateCheck[] = [];
  let foundCommand: string | null = null;
  let foundVersion: string | null = null;

  for (const candidate of candidates) {
    const testResult = testPythonCandidate(candidate, env);
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
    resolvedPython: foundCommand,
    resolvedVersion: foundVersion,
    candidatesChecked: tested,
    augmentedPath: env.PATH || ''
  };
}
