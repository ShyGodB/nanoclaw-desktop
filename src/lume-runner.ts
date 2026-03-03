/**
 * Lume VM Runner for NanoClaw
 * Runs agent inside a long-lived macOS VM via SSH, using the same
 * stdin/stdout protocol as the container runner.
 */
import { ChildProcess, execSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  CONTAINER_MAX_OUTPUT_SIZE,
  CONTAINER_TIMEOUT,
  DATA_DIR,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  LUME_VM_NAME,
  LUME_VM_USER,
  LUME_WORKSPACE,
} from './config.js';
import { ContainerInput, ContainerOutput } from './container-runner.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

/** Absolute path to the nanoclaw project root on the host. */
const PROJECT_ROOT = process.cwd();

/**
 * Where the host project dir appears inside the VM.
 * Lume mounts --shared-dir at /Volumes/My Shared Files/.
 */
const VM_SHARED_DIR = '/Volumes/My Shared Files';

let cachedVmIp: string | null = null;

/** Get the IP address of the Lume VM. */
function getLumeVmIp(): string {
  if (cachedVmIp) return cachedVmIp;

  // Try JSON format first (more reliable)
  try {
    const jsonOutput = execSync(`lume get ${LUME_VM_NAME} --format json`, {
      encoding: 'utf-8',
      timeout: 10000,
    });
    const vms = JSON.parse(jsonOutput);
    const vm = Array.isArray(vms) ? vms[0] : vms;
    if (vm?.ipAddress) {
      cachedVmIp = vm.ipAddress;
      return cachedVmIp!;
    }
  } catch {
    // Fall through to table parsing
  }

  // Fall back to table output parsing
  try {
    const output = execSync(`lume get ${LUME_VM_NAME}`, {
      encoding: 'utf-8',
      timeout: 10000,
    });
    const lines = output.trim().split('\n');
    if (lines.length < 2) throw new Error('No VM data');
    const dataLine = lines[1]; // Skip header
    const ipMatch = dataLine.match(/(\d+\.\d+\.\d+\.\d+)/);
    if (ipMatch) {
      cachedVmIp = ipMatch[1];
      return cachedVmIp!;
    }
  } catch {
    // Fall through
  }

  // Last resort: try SSH to known VM subnet IPs
  // Lume VMs typically get 192.168.64.x
  const knownIp = process.env.LUME_VM_IP;
  if (knownIp) {
    cachedVmIp = knownIp;
    return cachedVmIp;
  }

  throw new Error(
    `Failed to get Lume VM IP for "${LUME_VM_NAME}": no IP found (VM may be stopped)`,
  );
}

/**
 * Kill orphaned agent processes in the Lume VM.
 * Called at startup (to clean up after a crash) and shutdown (to prevent orphans).
 * Best-effort — logs warnings but never throws.
 */
export function cleanupLumeAgentProcesses(): void {
  try {
    const ip = getLumeVmIp();
    execSync(
      `ssh -o ConnectTimeout=3 -o StrictHostKeyChecking=no ${LUME_VM_USER}@${ip} "pkill -f 'agent-runner/dist/index' ; pkill -f 'ipc-mcp-stdio' ; pkill claude ; true"`,
      { timeout: 5000, stdio: 'pipe' },
    );
    logger.info({ ip }, 'Killed orphaned agent processes in Lume VM');
  } catch (err) {
    logger.warn({ err }, 'Failed to clean up Lume VM agent processes (VM may be unreachable)');
  }
}

/**
 * Sync code paths to the VM's local storage via SCP.
 * Bypasses VirtioFS cache — the VM always gets the latest files.
 * Called once at startup, after the VM is confirmed reachable.
 */
export function syncVmLocalFiles(): void {
  const ip = getLumeVmIp();
  const ssh = `ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no ${LUME_VM_USER}@${ip}`;
  const scp = `scp -o StrictHostKeyChecking=no`;
  const remote = (sub: string) => `/Users/${LUME_VM_USER}/local/${sub}`;

  // --- agent-runner ---
  const arLocal = path.join(PROJECT_ROOT, 'container', 'agent-runner');
  const arDist = path.join(arLocal, 'dist');
  const arRemote = remote('agent-runner');
  if (fs.existsSync(path.join(arDist, 'index.js'))) {
    try {
      execSync(`${ssh} "mkdir -p ${arRemote}/dist"`, { timeout: 10000, stdio: 'pipe' });
      for (const f of ['dist/index.js', 'dist/ipc-mcp-stdio.js', 'package.json']) {
        execSync(`${scp} "${path.join(arLocal, f)}" "${LUME_VM_USER}@${ip}:${arRemote}/${f}"`, { timeout: 15000, stdio: 'pipe' });
      }
      // Sync node_modules only if missing on VM
      const hasModules = execSync(`${ssh} "test -d ${arRemote}/node_modules && echo yes || echo no"`, { encoding: 'utf-8', timeout: 5000 }).trim();
      if (hasModules === 'no') {
        logger.info('Syncing agent-runner node_modules to VM (first deploy)...');
        execSync(`${scp} -r "${path.join(arLocal, 'node_modules')}" "${LUME_VM_USER}@${ip}:${arRemote}/"`, { timeout: 120000, stdio: 'pipe' });
      }
      logger.info('Synced agent-runner to VM');
    } catch (err) {
      logger.warn({ err }, 'Failed to sync agent-runner to VM');
    }
  }

  // --- tools (patchright-browser) ---
  const toolsLocal = path.join(PROJECT_ROOT, 'container', 'tools');
  const toolsRemote = remote('tools');
  if (fs.existsSync(path.join(toolsLocal, 'patchright-browser.mjs'))) {
    try {
      execSync(`${ssh} "mkdir -p ${toolsRemote}"`, { timeout: 10000, stdio: 'pipe' });
      for (const f of ['patchright-browser.mjs', 'package.json']) {
        execSync(`${scp} "${path.join(toolsLocal, f)}" "${LUME_VM_USER}@${ip}:${toolsRemote}/${f}"`, { timeout: 15000, stdio: 'pipe' });
      }
      // Make executable + create PATH-friendly symlink
      execSync(`${ssh} "chmod +x ${toolsRemote}/patchright-browser.mjs && ln -sf patchright-browser.mjs ${toolsRemote}/patchright-browser"`, { timeout: 10000, stdio: 'pipe' });
      // Install deps only if missing
      const hasModules = execSync(`${ssh} "test -d ${toolsRemote}/node_modules && echo yes || echo no"`, { encoding: 'utf-8', timeout: 5000 }).trim();
      if (hasModules === 'no') {
        logger.info('Installing tools dependencies on VM...');
        execSync(`${ssh} "cd ${toolsRemote} && PATH=\\$HOME/local/bin:/opt/homebrew/bin:\\$PATH npm install"`, { timeout: 60000, stdio: 'pipe' });
      }
      logger.info('Synced tools to VM');
    } catch (err) {
      logger.warn({ err }, 'Failed to sync tools to VM');
    }
  }
}

/** Check that the Lume VM is running and reachable. */
export function ensureLumeVmRunning(): void {
  // First, check if SSH is already reachable (VM may be running even if lume reports stopped)
  try {
    const ip = getLumeVmIp();
    execSync(
      `ssh -o ConnectTimeout=3 -o StrictHostKeyChecking=no ${LUME_VM_USER}@${ip} 'echo ok'`,
      { timeout: 6000, encoding: 'utf-8' },
    );

    // SSH is up — verify VirtioFS shared directory is actually mounted.
    // The VM can be running without --shared-dir (e.g. after a lume upgrade restarts
    // the daemon but not the VM process). In that case, stop and restart with --shared-dir.
    try {
      execSync(
        `ssh -o ConnectTimeout=3 -o StrictHostKeyChecking=no ${LUME_VM_USER}@${ip} 'ls /Volumes/My\\ Shared\\ Files/groups >/dev/null 2>&1'`,
        { timeout: 6000, encoding: 'utf-8' },
      );
      logger.info({ vm: LUME_VM_NAME, ip }, 'Lume VM already reachable via SSH');
      return;
    } catch {
      logger.warn({ vm: LUME_VM_NAME, ip }, 'Lume VM reachable but VirtioFS not mounted, restarting with --shared-dir');
      try { execSync(`lume stop ${LUME_VM_NAME}`, { timeout: 30000 }); } catch {}
      cachedVmIp = null;
      // Fall through to start VM with --shared-dir below
    }
  } catch {
    // SSH not reachable, try to start VM
    cachedVmIp = null;
  }

  try {
    logger.info({ vm: LUME_VM_NAME }, 'Lume VM not reachable, starting...');
    // lume run is a foreground/blocking command — spawn detached
    const child = spawn('lume', ['run', LUME_VM_NAME, '--shared-dir', PROJECT_ROOT], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();

    // Wait for VM to become running
    for (let i = 0; i < 30; i++) {
      const status = execSync(`lume get ${LUME_VM_NAME}`, {
        encoding: 'utf-8',
        timeout: 10000,
      });
      if (status.includes('running')) break;
      if (i === 29) throw new Error('VM not running after 60s');
      execSync('sleep 2');
    }

    // Clear cached IP since VM just started
    cachedVmIp = null;

    // Wait for SSH to become available
    const ip = getLumeVmIp();
    for (let i = 0; i < 30; i++) {
      try {
        execSync(
          `ssh -o ConnectTimeout=2 -o StrictHostKeyChecking=no ${LUME_VM_USER}@${ip} 'echo ok'`,
          { timeout: 5000 },
        );
        break;
      } catch {
        if (i === 29) throw new Error('VM SSH not reachable after 60s');
        execSync('sleep 2');
      }
    }
    logger.info({ vm: LUME_VM_NAME, ip }, 'Lume VM started');
  } catch (err) {
    logger.warn(
      { vm: LUME_VM_NAME, err },
      'Lume VM check failed (Lume may not be installed)',
    );
  }
}

/**
 * Prepare the workspace directories on the host.
 * Uses effectiveFolder (e.g. 'andy-workspace~t16') for per-topic isolation.
 */
function prepareVmWorkspace(effectiveFolder: string): void {
  // Ensure IPC directories exist on host (shared with VM)
  const groupIpcDir = path.join(DATA_DIR, 'ipc', effectiveFolder);
  fs.mkdirSync(path.join(groupIpcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'input'), { recursive: true });

  // Ensure group directory exists
  const groupDir = path.join(GROUPS_DIR, effectiveFolder);
  fs.mkdirSync(groupDir, { recursive: true });

  // Ensure sessions directory exists
  const groupSessionsDir = path.join(
    DATA_DIR,
    'sessions',
    effectiveFolder,
    '.claude',
  );
  fs.mkdirSync(groupSessionsDir, { recursive: true });

  // Write settings.json (if not exists) — matches container-runner behavior
  const settingsFile = path.join(groupSessionsDir, 'settings.json');
  if (!fs.existsSync(settingsFile)) {
    fs.writeFileSync(settingsFile, JSON.stringify({
      env: {
        CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
        CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
      },
    }, null, 2) + '\n');
  }

  // Sync skills from container/skills/ into each group's .claude/skills/
  const skillsSrc = path.join(PROJECT_ROOT, 'container', 'skills');
  const skillsDst = path.join(groupSessionsDir, 'skills');
  if (fs.existsSync(skillsSrc)) {
    for (const skillDir of fs.readdirSync(skillsSrc)) {
      const srcDir = path.join(skillsSrc, skillDir);
      if (!fs.statSync(srcDir).isDirectory()) continue;
      const dstDir = path.join(skillsDst, skillDir);
      fs.mkdirSync(dstDir, { recursive: true });
      for (const file of fs.readdirSync(srcDir)) {
        const srcFile = path.join(srcDir, file);
        const dstFile = path.join(dstDir, file);
        fs.copyFileSync(srcFile, dstFile);
      }
    }
  }
}

/** Read auth environment variables from .env for the agent. */
function getAuthEnvVars(): string {
  const envFile = path.join(PROJECT_ROOT, '.env');
  if (!fs.existsSync(envFile)) return '';

  const content = fs.readFileSync(envFile, 'utf-8');
  const allowedVars = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'GITHUB_TOKEN'];
  const exports: string[] = [];

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    for (const varName of allowedVars) {
      if (trimmed.startsWith(`${varName}=`)) {
        // Shell-safe: single-quote the value
        const value = trimmed.slice(varName.length + 1).replace(/'/g, "'\\''");
        exports.push(`export ${varName}='${value}'`);
      }
    }
  }

  return exports.join(' && ');
}

/**
 * Build the SSH command to run agent-runner inside the Lume VM.
 * Sets up workspace symlinks pointing to the shared directory, then runs
 * the agent-runner with WORKSPACE_BASE pointing to the workspace root.
 */
function buildSshCommand(
  vmIp: string,
  group: RegisteredGroup,
  isMain: boolean,
  effectiveFolder: string,
): string[] {
  // CRITICAL: Each container gets its own workspace directory.
  // Without this, concurrent containers overwrite each other's symlinks,
  // causing IPC messages (and agent output) to route to the wrong chat.
  const safeName = effectiveFolder.replace(/[^a-zA-Z0-9-]/g, '-');
  const ws = `${LUME_WORKSPACE}/${safeName}`;
  const shared = VM_SHARED_DIR;

  // Build a setup script that creates the workspace symlink structure:
  // {ws}/group/ → shared groups/{effectiveFolder}/
  // {ws}/ipc/ → shared data/ipc/{effectiveFolder}/
  // {ws}/global/ → shared groups/global/
  // {ws}/sessions/ → shared data/sessions/{effectiveFolder}/
  const parts: string[] = [];

  // Auth environment
  const authEnv = getAuthEnvVars();
  if (authEnv) parts.push(authEnv);

  // Setup symlinks (each container has its own ws dir, so no cross-contamination)
  parts.push(
    `mkdir -p "${ws}"`,
    `rm -rf "${ws}/group" "${ws}/ipc" "${ws}/global" "${ws}/sessions" "${ws}/agent-runner" "${ws}/tools"`,
    `ln -sf "${shared}/groups/${effectiveFolder}" "${ws}/group"`,
    `ln -sf "${shared}/data/ipc/${effectiveFolder}" "${ws}/ipc"`,
    `ln -sf "${shared}/groups/global" "${ws}/global"`,
    `ln -sf "${shared}/data/sessions/${effectiveFolder}" "${ws}/sessions"`,
    `ln -sf "/Users/${LUME_VM_USER}/local/agent-runner" "${ws}/agent-runner"`,
    `ln -sf "/Users/${LUME_VM_USER}/local/tools" "${ws}/tools"`,
    // Symlink .claude into the group dir so Claude Code SDK finds settings/skills
    // via the 'project' settings source (cwd = {ws}/group/).
    // This avoids racing on ~/.claude which is shared across all containers.
    `rm -f "${ws}/group/.claude"`,
    `ln -sf "${shared}/data/sessions/${effectiveFolder}/.claude" "${ws}/group/.claude"`,
  );

  // Main gets the project root symlink for full access
  // Must rm first: if project already exists as a symlink-to-directory,
  // ln -sf would create the new link *inside* the directory (not replace it),
  // causing /Volumes/My Shared Files/My Shared Files to appear on the host.
  if (isMain) {
    parts.push(`rm -rf "${ws}/project"`, `ln -sf "${shared}" "${ws}/project"`);
  }

  // Run agent-runner with browser support (headed mode for anti-detection)
  // Dynamically find Chromium instead of hardcoding version
  const browserPath = `$(find /Users/${LUME_VM_USER}/Library/Caches/ms-playwright -name 'Google Chrome for Testing' -type f 2>/dev/null | head -1)`;
  parts.push(
    `cd "${ws}" && WORKSPACE_BASE="${ws}" AGENT_BROWSER_EXECUTABLE_PATH="${browserPath}" AGENT_BROWSER_HEADED=1 BROWSER_LANG="${process.env.BROWSER_LANG || 'zh-CN'}" BROWSER_TIMEZONE="${process.env.BROWSER_TIMEZONE || 'Asia/Shanghai'}" QG_AUTH_KEY="${process.env.QG_AUTH_KEY || ''}" QG_AUTH_PWD="${process.env.QG_AUTH_PWD || ''}" PATH="${ws}/tools/node_modules/.bin:${ws}/tools:/Users/${LUME_VM_USER}/local/bin:/opt/homebrew/bin:$HOME/local/bin:$PATH" node "${ws}/agent-runner/dist/index.js"`,
  );

  return [
    'ssh',
    '-o',
    'StrictHostKeyChecking=no',
    '-o',
    'ServerAliveInterval=30',
    '-o',
    'ServerAliveCountMax=3',
    `${LUME_VM_USER}@${vmIp}`,
    parts.join(' && '),
  ];
}

export async function runLumeAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (proc: ChildProcess, containerName: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<ContainerOutput> {
  const startTime = Date.now();
  const vmIp = getLumeVmIp();

  const effectiveFolder = input.groupFolder;
  prepareVmWorkspace(effectiveFolder);

  const sshArgs = buildSshCommand(vmIp, group, input.isMain, effectiveFolder);
  const safeName = effectiveFolder.replace(/[^a-zA-Z0-9-]/g, '-');
  const vmName = `lume-${safeName}-${Date.now()}`;

  logger.info(
    {
      group: group.name,
      vmName,
      vmIp,
      isMain: input.isMain,
      effectiveFolder,
    },
    'Running agent in Lume VM via SSH',
  );

  const logsDir = path.join(GROUPS_DIR, effectiveFolder, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  return new Promise((resolve) => {
    const sshProc = spawn(sshArgs[0], sshArgs.slice(1), {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    onProcess(sshProc, vmName);

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;

    // Send input via stdin (same as container protocol)
    sshProc.stdin.write(JSON.stringify(input));
    sshProc.stdin.end();

    // Streaming output parsing (identical to container-runner)
    let parseBuffer = '';
    let newSessionId: string | undefined;
    let outputChain = Promise.resolve();
    let hadStreamingOutput = false;

    sshProc.stdout.on('data', (data) => {
      const chunk = data.toString();

      if (!stdoutTruncated) {
        const remaining = CONTAINER_MAX_OUTPUT_SIZE - stdout.length;
        if (chunk.length > remaining) {
          stdout += chunk.slice(0, remaining);
          stdoutTruncated = true;
        } else {
          stdout += chunk;
        }
      }

      if (onOutput) {
        parseBuffer += chunk;
        let startIdx: number;
        while ((startIdx = parseBuffer.indexOf(OUTPUT_START_MARKER)) !== -1) {
          const endIdx = parseBuffer.indexOf(OUTPUT_END_MARKER, startIdx);
          if (endIdx === -1) break;

          const jsonStr = parseBuffer
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
          parseBuffer = parseBuffer.slice(endIdx + OUTPUT_END_MARKER.length);

          try {
            const parsed: ContainerOutput = JSON.parse(jsonStr);
            if (parsed.newSessionId) {
              newSessionId = parsed.newSessionId;
            }
            hadStreamingOutput = true;
            resetTimeout();
            outputChain = outputChain.then(() => onOutput(parsed));
          } catch (err) {
            logger.warn(
              { group: group.name, error: err },
              'Failed to parse streamed output chunk',
            );
          }
        }
      }
    });

    sshProc.stderr.on('data', (data) => {
      const chunk = data.toString();
      const lines = chunk.trim().split('\n');
      for (const line of lines) {
        if (line) logger.debug({ vm: group.folder }, line);
      }
      if (stderrTruncated) return;
      const remaining = CONTAINER_MAX_OUTPUT_SIZE - stderr.length;
      if (chunk.length > remaining) {
        stderr += chunk.slice(0, remaining);
        stderrTruncated = true;
      } else {
        stderr += chunk;
      }
    });

    let timedOut = false;
    const configTimeout = group.containerConfig?.timeout || CONTAINER_TIMEOUT;
    const timeoutMs = Math.max(configTimeout, IDLE_TIMEOUT + 30_000);

    const killOnTimeout = () => {
      timedOut = true;
      logger.error({ group: group.name, vmName }, 'Lume SSH timeout, killing');
      sshProc.kill('SIGTERM');
      setTimeout(() => sshProc.kill('SIGKILL'), 5000);
    };

    let timeout = setTimeout(killOnTimeout, timeoutMs);

    const resetTimeout = () => {
      clearTimeout(timeout);
      timeout = setTimeout(killOnTimeout, timeoutMs);
    };

    sshProc.on('close', (code) => {
      clearTimeout(timeout);
      const duration = Date.now() - startTime;

      if (timedOut) {
        if (hadStreamingOutput) {
          logger.info(
            { group: group.name, vmName, duration },
            'Lume SSH timed out after output (idle cleanup)',
          );
          outputChain.then(() => {
            resolve({ status: 'success', result: null, newSessionId });
          });
          return;
        }
        resolve({
          status: 'error',
          result: null,
          error: `Lume VM timed out after ${configTimeout}ms`,
        });
        return;
      }

      // Write log
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const logFile = path.join(logsDir, `lume-${timestamp}.log`);
      fs.writeFileSync(
        logFile,
        [
          `=== Lume VM Run Log ===`,
          `Group: ${group.name}`,
          `VM: ${LUME_VM_NAME} (${vmIp})`,
          `Duration: ${duration}ms`,
          `Exit Code: ${code}`,
          ``,
          `=== Stderr ===`,
          stderr,
          ``,
          `=== Stdout ===`,
          stdout,
        ].join('\n'),
      );

      if (code !== 0) {
        logger.error(
          { group: group.name, code, duration, stderr: stderr.slice(-500) },
          'Lume SSH exited with error',
        );
        resolve({
          status: 'error',
          result: null,
          error: `Lume SSH exited with code ${code}: ${stderr.slice(-200)}`,
        });
        return;
      }

      // Streaming mode
      if (onOutput) {
        outputChain.then(() => {
          logger.info(
            { group: group.name, duration, newSessionId },
            'Lume VM completed (streaming mode)',
          );
          resolve({ status: 'success', result: null, newSessionId });
        });
        return;
      }

      // Legacy mode: parse last output
      try {
        const startIdx = stdout.indexOf(OUTPUT_START_MARKER);
        const endIdx = stdout.indexOf(OUTPUT_END_MARKER);
        let jsonLine: string;
        if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
          jsonLine = stdout
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
        } else {
          const lines = stdout.trim().split('\n');
          jsonLine = lines[lines.length - 1];
        }
        const output: ContainerOutput = JSON.parse(jsonLine);
        logger.info({ group: group.name, duration }, 'Lume VM completed');
        resolve(output);
      } catch (err) {
        logger.error(
          { group: group.name, stdout: stdout.slice(-500), error: err },
          'Failed to parse Lume output',
        );
        resolve({
          status: 'error',
          result: null,
          error: `Failed to parse Lume output: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    });

    sshProc.on('error', (err) => {
      clearTimeout(timeout);
      logger.error({ group: group.name, error: err }, 'SSH spawn error');
      resolve({
        status: 'error',
        result: null,
        error: `SSH spawn error: ${err.message}`,
      });
    });
  });
}
