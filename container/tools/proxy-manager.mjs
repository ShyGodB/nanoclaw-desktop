#!/usr/bin/env node
/**
 * Proxy Manager — manage per-workspace residential proxy IPs via Qingguo (青果网络) API.
 *
 * Usage:
 *   proxy-manager assign <topic> --city 上海 --isp 电信
 *   proxy-manager renew [topic]        # renew all if topic omitted
 *   proxy-manager list
 *   proxy-manager release <topic>
 *
 * Environment:
 *   QG_AUTH_KEY   — Qingguo API AuthKey (required for assign/renew/release)
 *   QG_AUTH_PWD   — Qingguo API AuthPwd (used for SOCKS5 proxy authentication)
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
   * Release (return) an IP back to the pool.
   * Only available for static IPs. Dynamic IPs auto-expire — /delete is not supported.
   * Endpoint: GET https://longterm.proxy.qg.net/delete?key=XXX&ip=XXX
   */
  async releaseIP(ip) {
    // Dynamic IPs (24h rotation) cannot be released via API — they auto-expire.
    // This method is kept for future static IP support.
    console.log(`  Note: dynamic IP auto-expires, no release needed`);
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

function deleteProxy(topic) {
  const p = proxyPath(topic);
  if (fs.existsSync(p)) fs.unlinkSync(p);
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

    // Release old IP (auto-expires, but log it)
    try {
      await client.releaseIP(existing.server);
    } catch (e) {
      console.warn(`  Warning: ${e.message}`);
    }

    // Extract new IP with same area + ISP
    try {
      const result = await client.extractIP({
        area: existing.areaCode || '',
        isp: existing.ispInput || existing.isp,
      });

      const proxyServer = QG_AUTH_PWD
        ? `socks5://${QG_AUTH_KEY}:${QG_AUTH_PWD}@${result.server}`
        : `socks5://${result.server}`;

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

function cmdList() {
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

async function cmdRelease(topic) {
  const existing = readProxy(topic);
  if (!existing) {
    console.log(`${topic}: no .proxy file`);
    return;
  }

  if (QG_AUTH_KEY) {
    const client = new QinguoClient(QG_AUTH_KEY);
    try {
      await client.releaseIP(existing.server);
    } catch (e) {
      console.warn(`Warning: ${e.message}`);
    }
  }

  deleteProxy(topic);
  console.log(`${topic}: .proxy file removed`);
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
    cmdList();
    break;
  }
  case 'release': {
    if (!args[0]) {
      console.error('Usage: proxy-manager release <topic>');
      process.exit(1);
    }
    cmdRelease(args[0]).catch(e => { console.error(e.message); process.exit(1); });
    break;
  }
  default:
    console.log(`Proxy Manager — manage per-workspace residential proxy IPs via Qingguo

Commands:
  assign <topic> [--area <code>] [--isp <电信|移动|联通>]   Extract IP and assign
  renew [topic]                                            Renew IP (all if omitted)
  list                                                     List all proxy assignments
  release <topic>                                          Release IP and remove config

Environment:
  QG_AUTH_KEY   Qingguo API AuthKey (required)
  QG_AUTH_PWD   Qingguo API AuthPwd (for SOCKS5 auth)
  GROUPS_DIR    Path to groups directory (default: ./groups)

Area codes: 行政区划代码, e.g. 120100=天津, 310100=上海, 110100=北京
ISP values: 电信, 移动, 联通 (default: 不限)`);
}
