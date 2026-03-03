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

const GROUPS_DIR = process.env.GROUPS_DIR || path.join(process.cwd(), 'groups');
const QG_AUTH_KEY = process.env.QG_AUTH_KEY || '';
const QG_AUTH_PWD = process.env.QG_AUTH_PWD || '';
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

function writeProxy(topic, data) {
  const dir = path.join(GROUPS_DIR, topic, BROWSER_DATA_DIR);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(proxyPath(topic), JSON.stringify(data, null, 2));
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
  console.log(`Assigned to ${topic}: ${proxyServer}`);
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

    console.log(`${t}: renewing (${existing.area}/${existing.isp}) ...`);

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
      console.error(`  Error renewing ${t}: ${e.message}`);
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
    console.log(`${t.padEnd(20)} ${(p.proxyIp || '?').padEnd(18)} ${(p.area || '?').padEnd(12)} ${(p.isp || '?').padEnd(6)}  deadline: ${p.deadline || 'unknown'}`);
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
    console.log(`${t} (task: ${taskId}):`);
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
      console.log(`${t}: no proxy configured`);
      continue;
    }

    // Parse host:port from socks5://host:port
    const serverUrl = p.server.replace(/^socks5:\/\//, '');
    const testUrl = 'http://httpbin.org/ip';

    process.stdout.write(`${t}: testing ${p.proxyIp} (${p.area}/${p.isp}) ... `);

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

// --- CLI entry ---

const [,, cmd, ...args] = process.argv;

switch (cmd) {
  case 'assign': {
    const topic = args[0];
    const areaIdx = args.indexOf('--area');
    const ispIdx = args.indexOf('--isp');
    const area = areaIdx >= 0 ? args[areaIdx + 1] : '';
    const isp = ispIdx >= 0 ? args[ispIdx + 1] : '不限';
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
  default:
    console.log(`Proxy Manager — manage per-workspace residential proxy IPs via Qingguo

Commands:
  assign <topic> [--area <code>] [--isp <电信|移动|联通>]   Extract IP and assign
  renew [topic]                                            Renew IP (all if omitted)
  list                                                     List assignments + channel status
  query [topic]                                            Query actual in-use IPs from API
  test [topic]                                             Test proxy connectivity (all if omitted)
  resources                                                List available areas & ISPs for key

Environment:
  QG_AUTH_KEY   Qingguo API AuthKey (required)
  QG_AUTH_PWD   Qingguo API AuthPwd (for SOCKS5 auth)
  GROUPS_DIR    Path to groups directory (default: ./groups)

Area codes: 行政区划代码, e.g. 120100=天津, 310100=上海, 110100=北京
ISP values: 电信, 移动, 联通 (default: 不限)`);
}
