#!/usr/bin/env node
/**
 * Proxy Manager — manage per-workspace residential proxy IPs via Qingguo (青果网络) API.
 *
 * Usage:
 *   proxy-manager assign <topic> --area 440300 --isp 电信
 *   proxy-manager renew [topic]        # renew all if topic omitted
 *   proxy-manager list
 *   proxy-manager query [topic]        # query actual in-use IPs from Qingguo API
 *   proxy-manager resources             # list available areas & ISPs for current key
 *   proxy-manager test [topic]          # test proxy connectivity (all if omitted)
 *
 * Environment:
 *   QG_AUTH_KEY   — Qingguo API AuthKey (required for assign/renew/query)
 *   QG_AUTH_PWD   — Qingguo API AuthPwd (for SOCKS5 auth fallback)
 *   GROUPS_DIR    — path to groups directory (default: ./groups)
 */

import fs from 'fs';
import path from 'path';
import childProcess from 'child_process';

const GROUPS_DIR = process.env.GROUPS_DIR || path.join(process.cwd(), 'groups');
const QG_AUTH_KEY = process.env.QG_AUTH_KEY || '';
const QG_AUTH_PWD = process.env.QG_AUTH_PWD || '';
const QG_DEFAULT_AREA = process.env.QG_DEFAULT_AREA || '';
const QG_DEFAULT_ISP = process.env.QG_DEFAULT_ISP || '不限';
const PROXY_FILENAME = '.proxy';
const BROWSER_DATA_DIR = '.browser-data';

// ISP name → API code mapping
const ISP_MAP = { '不限': 0, '电信': 1, '移动': 2, '联通': 3 };

// --- Qingguo API client ---

class QinguoClient {
  constructor(authKey) {
    this.authKey = authKey;
    this.baseUrl = 'https://longterm.proxy.qg.net';
  }

  /**
   * Extract a long-duration residential IP.
   * @param {object} opts - { area, isp }
   *   area: 地区编码 (如 "120100" 天津), 空串=不限
   *   isp:  运营商名称 (电信/移动/联通) 或编码 (0/1/2/3)
   * @returns {Promise<{ server, proxyIp, area, isp, deadline }>}
   */
  async extractIP({ area = '', isp = '不限' }) {
    const ispCode = typeof isp === 'number' ? isp : (ISP_MAP[isp] ?? 0);
    const url = new URL('/get', this.baseUrl);
    url.searchParams.set('key', this.authKey);
    url.searchParams.set('num', '1');
    url.searchParams.set('area', area);
    url.searchParams.set('isp', String(ispCode));
    url.searchParams.set('format', 'json');
    url.searchParams.set('distinct', 'true');

    const res = await fetch(url.toString());
    const json = await res.json();

    if (json.code !== 'SUCCESS') {
      throw new Error(`Qingguo API error: ${json.code} (request_id: ${json.request_id || 'N/A'})`);
    }
    if (!json.data || json.data.length === 0) {
      throw new Error('Qingguo API returned no IPs');
    }

    const ip = json.data[0];
    return {
      server: ip.server,             // "60.188.69.163:22294"
      proxyIp: ip.proxy_ip,          // real outbound IP
      areaCode: ip.area_code,        // 130227
      area: ip.area,                 // "河北省唐山市迁西县"
      isp: ip.isp,                   // "电信"
      taskId: ip.task_id,            // for release API
      deadline: ip.deadline,         // "2026-03-03 21:38:38"
    };
  }

  /**
   * Query channel availability.
   * Endpoint: GET https://longterm.proxy.qg.net/channels?key=XXX
   * @returns {Promise<{ total: number, idle: number }>}
   */
  async queryChannels() {
    const url = new URL('/channels', this.baseUrl);
    url.searchParams.set('key', this.authKey);
    const res = await fetch(url.toString());
    const json = await res.json();
    if (json.code !== 'SUCCESS') {
      throw new Error(`Qingguo channels error: ${json.code}`);
    }
    return json.data; // { total, idle }
  }

  /**
   * Query available resource areas & ISPs for this key.
   * Endpoint: GET https://longterm.proxy.qg.net/resources?key=XXX
   * Each item: { area, area_code, isp, isp_code, available }
   * Use this to know which area+isp combos are valid for assign.
   * @returns {Promise<Array>}
   */
  async queryResources() {
    const url = new URL('/resources', this.baseUrl);
    url.searchParams.set('key', this.authKey);
    const res = await fetch(url.toString());
    const json = await res.json();
    if (json.code !== 'SUCCESS') {
      throw new Error(`Qingguo resources error: ${json.code}`);
    }
    return json.data || [];
  }

  /**
   * Query actual in-use IPs from Qingguo.
   * Endpoint: GET https://longterm.proxy.qg.net/query?key=XXX&task=XXX
   * When "IP离线自动更换" is enabled, the returned IP may differ from the originally extracted one.
   * @param {string} [taskId] - specific task_id, or omit for all
   * @returns {Promise<Array>} array of in-use IP objects
   */
  async queryIP(taskId) {
    const url = new URL('/query', this.baseUrl);
    url.searchParams.set('key', this.authKey);
    if (taskId) url.searchParams.set('task', taskId);

    const res = await fetch(url.toString());
    const json = await res.json();

    if (json.code !== 'SUCCESS') {
      throw new Error(`Qingguo query error: ${json.code} (request_id: ${json.request_id || 'N/A'})`);
    }
    return json.data || [];
  }

  // --- IP Whitelist API (https://proxy.qg.net) ---

  /** Query current whitelist IPs */
  async whitelistQuery() {
    const url = `https://proxy.qg.net/whitelist/query?Key=${this.authKey}`;
    const res = await fetch(url);
    const json = await res.json();
    if (json.Code !== 0) {
      throw new Error(`Whitelist query error: Code ${json.Code}`);
    }
    return json.Data || [];
  }

  /** Add IPs to whitelist (comma-separated string or array) */
  async whitelistAdd(ips) {
    const ipStr = Array.isArray(ips) ? ips.join(',') : ips;
    const url = `https://proxy.qg.net/whitelist/add?Key=${this.authKey}&IP=${ipStr}`;
    const res = await fetch(url);
    const json = await res.json();
    if (json.Code !== 0) {
      const msgs = { '-1': 'unknown error', '-10': 'invalid params', '-11': 'rate limited', '-100': 'plan expired', '-202': 'whitelist limit exceeded', '-206': 'IP already in use by another key' };
      throw new Error(`Whitelist add error: Code ${json.Code} — ${msgs[String(json.Code)] || json.Msg || ''}`);
    }
    return json.Data || [];
  }

  /** Remove IPs from whitelist (comma-separated string or array) */
  async whitelistDel(ips) {
    const ipStr = Array.isArray(ips) ? ips.join(',') : ips;
    const url = `https://proxy.qg.net/whitelist/del?Key=${this.authKey}&IP=${ipStr}`;
    const res = await fetch(url);
    const json = await res.json();
    if (json.Code !== 0) {
      throw new Error(`Whitelist del error: Code ${json.Code}`);
    }
    return json.Data || [];
  }
}

// --- Proxy file helpers ---

function proxyPath(topic) {
  return path.join(GROUPS_DIR, topic, BROWSER_DATA_DIR, PROXY_FILENAME);
}

function readProxy(topic) {
  const p = proxyPath(topic);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {
    return null;
  }
}

function readTopicMeta(topic) {
  const p = path.join(GROUPS_DIR, topic, '.topic-meta.json');
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {
    return null;
  }
}

/** Human-readable label: "workspace~t2 (小红书)" or just "workspace~t2" */
function topicLabel(topic) {
  const meta = readTopicMeta(topic);
  return meta?.topicName ? `${topic} (${meta.topicName})` : topic;
}

function writeProxy(topic, data) {
  const dir = path.join(GROUPS_DIR, topic, BROWSER_DATA_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const p = proxyPath(topic);
  fs.writeFileSync(p, JSON.stringify(data, null, 2));

  // Sync to Lume VM to bypass VirtioFS cache
  syncProxyToVM(topic, p);
}

/** SCP .proxy file to Lume VM workspace if VM is configured */
function syncProxyToVM(topic, localPath) {
  const vmIp = process.env.LUME_VM_IP;
  const vmUser = process.env.LUME_VM_USER || 'lume';
  if (!vmIp) return;

  const safeName = topic.replace(/[^a-zA-Z0-9-]/g, '-');
  const vmDir = `/Users/${vmUser}/workspace/${safeName}/group/${BROWSER_DATA_DIR}`;
  const vmPath = `${vmDir}/${PROXY_FILENAME}`;

  try {
    const { execSync } = childProcess;
    execSync(`ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no ${vmUser}@${vmIp} "mkdir -p ${vmDir}"`, { timeout: 10000 });
    execSync(`scp -o ConnectTimeout=5 -o StrictHostKeyChecking=no "${localPath}" ${vmUser}@${vmIp}:"${vmPath}"`, { timeout: 10000 });
    console.log(`  Synced to VM: ${vmPath}`);
  } catch (e) {
    console.warn(`  Warning: could not sync to VM (${e.message})`);
  }
}

/** Find all topics that have a .proxy file */
function findProxiedTopics() {
  if (!fs.existsSync(GROUPS_DIR)) return [];
  return fs.readdirSync(GROUPS_DIR).filter(name => {
    const p = proxyPath(name);
    return fs.existsSync(p);
  });
}

// --- Commands ---

async function cmdAssign(topic, area, isp) {
  if (!QG_AUTH_KEY) {
    console.error('Error: QG_AUTH_KEY environment variable is required');
    process.exit(1);
  }

  const client = new QinguoClient(QG_AUTH_KEY);
  console.log(`Extracting residential IP: area=${area}, isp=${isp} ...`);
  const result = await client.extractIP({ area, isp });

  // SOCKS5 proxy URL — auth via IP whitelist, not inline credentials
  // (Chromium --proxy-server does not support socks5://user:pass@host:port)
  const proxyServer = `socks5://${result.server}`;

  const proxyData = {
    server: proxyServer,
    proxyIp: result.proxyIp,
    area: result.area,
    areaCode: area || String(result.areaCode || ''),
    isp: result.isp,
    ispInput: isp,
    taskId: result.taskId,
    timezone: 'Asia/Shanghai',
    lang: 'zh-CN',
    assignedAt: new Date().toISOString(),
    deadline: result.deadline,
  };

  writeProxy(topic, proxyData);
  console.log(`Assigned to ${topicLabel(topic)}: ${proxyServer}`);
  console.log(`Real outbound IP: ${result.proxyIp}`);
  console.log(`Area: ${result.area} / ${result.isp}`);
  console.log(`Deadline: ${result.deadline}`);
}

async function cmdRenew(topic) {
  const topics = topic ? [topic] : findProxiedTopics();
  if (topics.length === 0) {
    console.log('No proxied workspaces found.');
    return;
  }

  if (!QG_AUTH_KEY) {
    console.error('Error: QG_AUTH_KEY environment variable is required');
    process.exit(1);
  }

  const client = new QinguoClient(QG_AUTH_KEY);

  for (const t of topics) {
    const existing = readProxy(t);
    if (!existing) {
      console.log(`${t}: no .proxy file, skipping`);
      continue;
    }

    console.log(`${topicLabel(t)}: renewing (${existing.area}/${existing.isp}) ...`);

    // Extract new IP with same area + ISP (old IP auto-expires)
    try {
      const result = await client.extractIP({
        area: existing.areaCode || '',
        isp: existing.ispInput || existing.isp,
      });

      const proxyServer = `socks5://${result.server}`;

      const proxyData = {
        ...existing,
        server: proxyServer,
        proxyIp: result.proxyIp,
        area: result.area,
        isp: result.isp,
        taskId: result.taskId,
        assignedAt: new Date().toISOString(),
        deadline: result.deadline,
      };

      writeProxy(t, proxyData);
      console.log(`  New IP: ${proxyServer}`);
      console.log(`  Real outbound: ${result.proxyIp}`);
      console.log(`  Deadline: ${result.deadline}`);
    } catch (e) {
      console.error(`  Error renewing ${topicLabel(t)}: ${e.message}`);
    }
  }
}

async function cmdList() {
  // Show channel availability
  if (QG_AUTH_KEY) {
    try {
      const client = new QinguoClient(QG_AUTH_KEY);
      const ch = await client.queryChannels();
      console.log(`Channels: ${ch.idle} idle / ${ch.total} total\n`);
    } catch (e) {
      console.warn(`Could not query channels: ${e.message}\n`);
    }
  }

  const topics = findProxiedTopics();
  if (topics.length === 0) {
    console.log('No proxied workspaces.');
    return;
  }

  for (const t of topics) {
    const p = readProxy(t);
    console.log(`${topicLabel(t).padEnd(30)} ${(p.proxyIp || '?').padEnd(18)} ${(p.area || '?').padEnd(12)} ${(p.isp || '?').padEnd(6)}  deadline: ${p.deadline || 'unknown'}`);
  }
}

async function cmdQuery(topic) {
  if (!QG_AUTH_KEY) {
    console.error('Error: QG_AUTH_KEY environment variable is required');
    process.exit(1);
  }

  const client = new QinguoClient(QG_AUTH_KEY);

  // If topic specified, query its task_id; otherwise query all
  const topics = topic ? [topic] : findProxiedTopics();
  const taskIds = [];

  for (const t of topics) {
    const p = readProxy(t);
    if (p?.taskId) taskIds.push({ topic: t, taskId: p.taskId });
  }

  if (taskIds.length === 0 && !topic) {
    // No local .proxy files — query all in-use IPs from API
    console.log('Querying all in-use IPs from Qingguo API...\n');
    const ips = await client.queryIP();
    if (ips.length === 0) {
      console.log('No in-use IPs.');
      return;
    }
    for (const ip of ips) {
      console.log(`  ${ip.proxy_ip.padEnd(18)} ${(ip.area || '?').padEnd(16)} ${(ip.isp || '?').padEnd(6)}  server: ${ip.server}  task: ${ip.task_id}  deadline: ${ip.deadline}`);
    }
    return;
  }

  for (const { topic: t, taskId } of taskIds) {
    console.log(`${topicLabel(t)} (task: ${taskId}):`);
    try {
      const ips = await client.queryIP(taskId);
      if (ips.length === 0) {
        console.log('  No in-use IPs for this task.\n');
        continue;
      }
      for (const ip of ips) {
        const p = readProxy(t);
        const changed = p?.proxyIp && p.proxyIp !== ip.proxy_ip ? ' ⚠ IP changed by auto-replace!' : '';
        console.log(`  proxy_ip: ${ip.proxy_ip}  server: ${ip.server}  area: ${ip.area}  isp: ${ip.isp}  deadline: ${ip.deadline}${changed}`);
      }
    } catch (e) {
      console.error(`  Error: ${e.message}`);
    }
    console.log();
  }
}

async function cmdTest(topic) {
  const topics = topic ? [topic] : findProxiedTopics();
  if (topics.length === 0) {
    console.log('No proxied workspaces found.');
    return;
  }

  for (const t of topics) {
    const p = readProxy(t);
    if (!p?.server) {
      console.log(`${topicLabel(t)}: no proxy configured`);
      continue;
    }

    // Parse host:port from socks5://host:port
    const serverUrl = p.server.replace(/^socks5:\/\//, '');
    const testUrl = 'http://httpbin.org/ip';

    process.stdout.write(`${topicLabel(t)}: testing ${p.proxyIp} (${p.area}/${p.isp}) ... `);

    try {
      // Try without auth first (IP whitelist), then with auth
      let result = await testSocks5(serverUrl, testUrl);
      if (!result && QG_AUTH_KEY && QG_AUTH_PWD) {
        result = await testSocks5(serverUrl, testUrl, QG_AUTH_KEY, QG_AUTH_PWD);
        if (result) {
          console.log(`✓ ${result.origin} (auth required — add this machine to IP whitelist)`);
          continue;
        }
      }
      if (result) {
        const match = result.origin === p.proxyIp ? '✓' : '⚠ IP mismatch!';
        console.log(`${match} ${result.origin}`);
      } else {
        console.log('✗ connection failed');
      }
    } catch (e) {
      console.log(`✗ ${e.message}`);
    }
  }
}

/**
 * Test SOCKS5 proxy by fetching a URL via curl.
 * Returns parsed JSON or null on failure.
 */
async function testSocks5(server, url, user, pass) {
  const { execSync } = await import('child_process');
  const args = ['curl', '-s', '--socks5', server, '--connect-timeout', '10'];
  if (user && pass) args.push('--proxy-user', `${user}:${pass}`);
  args.push(url);
  try {
    const out = execSync(args.join(' '), { timeout: 15000 }).toString();
    return JSON.parse(out);
  } catch {
    return null;
  }
}

async function cmdResources() {
  if (!QG_AUTH_KEY) {
    console.error('Error: QG_AUTH_KEY environment variable is required');
    process.exit(1);
  }

  const client = new QinguoClient(QG_AUTH_KEY);
  const resources = await client.queryResources();

  if (resources.length === 0) {
    console.log('No available resources for this key.');
    return;
  }

  // Group by province for readability
  const byProvince = {};
  for (const r of resources) {
    // Extract province from area name (e.g. "河北省秦皇岛市" → "河北省")
    const province = r.area.match(/^(.+?省|.+?市|.+?自治区)/)?.[1] || r.area;
    if (!byProvince[province]) byProvince[province] = [];
    byProvince[province].push(r);
  }

  const available = resources.filter(r => r.available).length;
  console.log(`Resources: ${available} available / ${resources.length} total\n`);

  for (const [province, items] of Object.entries(byProvince)) {
    console.log(`${province}:`);
    for (const r of items) {
      const status = r.available ? '✓' : '✗';
      console.log(`  ${status} ${r.area.padEnd(14)} ${String(r.area_code).padEnd(8)} ${r.isp}`);
    }
  }
}

/** Detect this machine's public IP via httpbin */
async function getPublicIP() {
  const res = await fetch('https://httpbin.org/ip');
  const json = await res.json();
  return json.origin;
}

async function cmdWhitelist(action, ipArg) {
  if (!QG_AUTH_KEY) {
    console.error('Error: QG_AUTH_KEY environment variable is required');
    process.exit(1);
  }

  const client = new QinguoClient(QG_AUTH_KEY);

  switch (action) {
    case 'add': {
      const ip = ipArg || await getPublicIP();
      console.log(`Adding ${ip} to whitelist ...`);
      const result = await client.whitelistAdd(ip);
      console.log(`Whitelist now: ${result.join(', ') || '(empty)'}`);
      break;
    }
    case 'del':
    case 'remove': {
      if (!ipArg) {
        console.error('Usage: proxy-manager whitelist del <ip>');
        process.exit(1);
      }
      console.log(`Removing ${ipArg} from whitelist ...`);
      await client.whitelistDel(ipArg);
      console.log(`Removed ${ipArg}`);
      break;
    }
    default: {
      // Default: query / show current whitelist
      const ips = await client.whitelistQuery();
      if (ips.length === 0) {
        console.log('Whitelist is empty.');
      } else {
        console.log(`Whitelist (${ips.length}):`);
        for (const ip of ips) console.log(`  ${ip}`);
      }
      // Also show current public IP for reference
      try {
        const myIp = await getPublicIP();
        const inList = ips.includes(myIp);
        console.log(`\nThis machine: ${myIp} ${inList ? '(in whitelist)' : '(NOT in whitelist)'}`);
      } catch {}
      break;
    }
  }
}

// --- CLI entry ---

const [,, cmd, ...args] = process.argv;

switch (cmd) {
  case 'assign': {
    const topic = args[0];
    const areaIdx = args.indexOf('--area');
    const ispIdx = args.indexOf('--isp');
    const area = areaIdx >= 0 ? args[areaIdx + 1] : QG_DEFAULT_AREA;
    const isp = ispIdx >= 0 ? args[ispIdx + 1] : QG_DEFAULT_ISP;
    if (!topic) {
      console.error('Usage: proxy-manager assign <topic> [--area <code>] [--isp <电信|移动|联通>]');
      process.exit(1);
    }
    cmdAssign(topic, area, isp).catch(e => { console.error(e.message); process.exit(1); });
    break;
  }
  case 'renew': {
    cmdRenew(args[0]).catch(e => { console.error(e.message); process.exit(1); });
    break;
  }
  case 'list': {
    cmdList().catch(e => { console.error(e.message); process.exit(1); });
    break;
  }
  case 'query': {
    cmdQuery(args[0]).catch(e => { console.error(e.message); process.exit(1); });
    break;
  }
  case 'test': {
    cmdTest(args[0]).catch(e => { console.error(e.message); process.exit(1); });
    break;
  }
  case 'resources': {
    cmdResources().catch(e => { console.error(e.message); process.exit(1); });
    break;
  }
  case 'whitelist': {
    cmdWhitelist(args[0], args[1]).catch(e => { console.error(e.message); process.exit(1); });
    break;
  }
  default:
    console.log(`Proxy Manager — manage per-workspace residential proxy IPs via Qingguo

Commands:
  assign <topic> [--area <code>] [--isp <电信|移动|联通>]   Extract IP and assign
  renew [topic]                                            Renew IP (all if omitted)
  list                                                     List assignments + channel status
  query [topic]                                            Query actual in-use IPs from API
  test [topic]                                             Test proxy connectivity (all if omitted)
  resources                                                List available areas & ISPs for key
  whitelist                                                Show current IP whitelist
  whitelist add [ip]                                       Add IP to whitelist (auto-detect if omitted)
  whitelist del <ip>                                       Remove IP from whitelist

Environment:
  QG_AUTH_KEY       Qingguo API AuthKey (required)
  QG_AUTH_PWD       Qingguo API AuthPwd (for SOCKS5 auth)
  QG_DEFAULT_AREA   Default area code for assign (e.g. 440300=深圳)
  QG_DEFAULT_ISP    Default ISP for assign (电信/移动/联通, default: 不限)
  GROUPS_DIR        Path to groups directory (default: ./groups)

Area codes: 行政区划代码, e.g. 440300=深圳, 310100=上海, 110100=北京
ISP values: 电信, 移动, 联通 (default: 不限)`);
}
