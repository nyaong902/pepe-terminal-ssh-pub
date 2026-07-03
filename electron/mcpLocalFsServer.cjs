#!/usr/bin/env node
'use strict';

// Minimal MCP stdio server exposing filesystem access to synced local attachment roots.
// The roots are provided by the main process via PEPE_LOCAL_ROOTS (JSON array).

const fs = require('fs');
const path = require('path');

const ROOTS = (() => {
  try {
    const parsed = JSON.parse(process.env.PEPE_LOCAL_ROOTS || '[]');
    if (Array.isArray(parsed)) {
      return parsed.map(String).filter(Boolean);
    }
  } catch {}
  return [];
})();

const DEFAULT_ROOT = ROOTS[0] || process.cwd();

let stdoutBroken = false;
try {
  process.stdout.on('error', (err) => {
    if (err && (err.code === 'EPIPE' || err.code === 'ERR_STREAM_DESTROYED')) {
      stdoutBroken = true;
      try { process.exit(0); } catch {}
    }
  });
} catch {}

function sendMsg(msg) {
  if (stdoutBroken) return;
  try {
    process.stdout.write(JSON.stringify(msg) + '\n');
  } catch (err) {
    if (err && (err.code === 'EPIPE' || err.code === 'ERR_STREAM_DESTROYED')) {
      stdoutBroken = true;
      try { process.exit(0); } catch {}
    }
  }
}

function shq(p) {
  return "'" + String(p).replace(/'/g, "'\\''") + "'";
}

function normalizeRoots() {
  const roots = ROOTS.length > 0 ? ROOTS : [DEFAULT_ROOT];
  return Array.from(new Set(roots.map(r => path.resolve(r))));
}

const REAL_ROOTS = normalizeRoots();

function isWithinRoot(candidate) {
  const abs = path.resolve(candidate);
  return REAL_ROOTS.some(root => abs === root || abs.startsWith(root + path.sep));
}

function resolveInputPath(p) {
  const raw = String(p || '').trim();
  if (!raw) throw new Error('path is required');
  if (path.isAbsolute(raw)) {
    const abs = path.resolve(raw);
    if (!isWithinRoot(abs)) throw new Error(`Path is outside synced roots: ${raw}`);
    return abs;
  }
  const abs = path.resolve(REAL_ROOTS[0], raw);
  if (!isWithinRoot(abs)) throw new Error(`Path is outside synced roots: ${raw}`);
  return abs;
}

function globToRegExp(glob) {
  const esc = String(glob || '*')
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '::DOUBLESTAR::')
    .replace(/\*/g, '[^/\\\\]*')
    .replace(/\?/g, '[^/\\\\]')
    .replace(/::DOUBLESTAR::/g, '.*');
  return new RegExp(`^${esc}$`, 'i');
}

async function readTextFile(filePath) {
  const buf = await fs.promises.readFile(filePath);
  let text = buf.toString('utf-8');
  if (text.includes('�')) {
    try {
      const alt = new TextDecoder('euc-kr').decode(buf);
      const curBad = (text.match(/�/g) || []).length;
      const altBad = (alt.match(/�/g) || []).length;
      if (altBad < curBad) text = alt;
    } catch {}
  }
  return text;
}

async function listDirectory(dirPath) {
  const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
  const out = [];
  for (const entry of entries) {
    const full = path.join(dirPath, entry.name);
    try {
      const st = await fs.promises.stat(full);
      out.push({
        name: entry.name,
        path: full,
        isDir: entry.isDirectory(),
        size: st.size,
        mtimeMs: st.mtimeMs,
      });
    } catch {}
  }
  return out;
}

async function walkFiles(basePath, options, visit) {
  const { maxResults = 200, ignoreCase = false, glob = '' } = options || {};
  const pat = String(options?.pattern || '');
  const globRe = glob ? globToRegExp(glob) : null;
  const seen = { count: 0 };
  const max = Math.max(1, Math.min(5000, Number(maxResults) || 200));
  const needle = ignoreCase ? pat.toLowerCase() : pat;

  const walk = async (cur) => {
    if (seen.count >= max) return;
    let entries = [];
    try { entries = await fs.promises.readdir(cur, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (seen.count >= max) return;
      const full = path.join(cur, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      const name = entry.name;
      const cmp = ignoreCase ? name.toLowerCase() : name;
      const text = `${full}${path.sep}${name}`;
      const matchesPattern = !pat || cmp.includes(needle) || text.includes(pat);
      const matchesGlob = !globRe || globRe.test(name) || globRe.test(path.relative(basePath, full));
      if (matchesPattern && matchesGlob) {
        seen.count++;
        await visit(full, entry);
      }
    }
  };
  await walk(basePath);
}

const TOOLS = [
  {
    name: 'list_roots',
    description: 'List the synced local attachment roots available to this session.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_directory',
    description: 'List files and folders inside a synced local attachment root.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute or root-relative path inside the synced roots.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'read_file',
    description: 'Read a text file from the synced local attachment roots.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute or root-relative file path inside the synced roots.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'glob_files',
    description: 'Find files by glob pattern inside the synced local attachment roots.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern such as **/*.ts or *.md.' },
        path: { type: 'string', description: 'Optional base path inside the synced roots.' },
        max_results: { type: 'number', description: 'Maximum number of matches to return.' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'search_files',
    description: 'Search file contents in the synced local attachment roots.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Substring or regex to search for.' },
        path: { type: 'string', description: 'Optional base path inside the synced roots.' },
        glob: { type: 'string', description: 'Optional filename glob filter.' },
        ignore_case: { type: 'boolean', description: 'Case-insensitive search.' },
        max_results: { type: 'number', description: 'Maximum number of matches to return.' },
      },
      required: ['pattern'],
    },
  },
];

function toolError(id, message) {
  sendMsg({ jsonrpc: '2.0', id, error: { code: -32000, message: String(message) } });
}

async function handleCall(id, name, args) {
  try {
    if (name === 'list_roots') {
      const text = REAL_ROOTS.map((r, i) => `${i + 1}. ${r}`).join('\n') || '(none)';
      sendMsg({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `Synced roots:\n${text}` }], isError: false } });
      return;
    }

    const p = resolveInputPath(args.path || '');
    if (name === 'list_directory') {
      const items = await listDirectory(p);
      const text = items.map(item => `${item.isDir ? 'd' : '-'} ${item.path}`).join('\n') || '(empty)';
      sendMsg({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], isError: false } });
      return;
    }

    if (name === 'read_file') {
      const stat = await fs.promises.stat(p);
      if (stat.isDirectory()) throw new Error(`${p} is a directory`);
      const text = await readTextFile(p);
      sendMsg({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], isError: false } });
      return;
    }

    if (name === 'glob_files') {
      const base = args.path ? resolveInputPath(args.path) : REAL_ROOTS[0];
      const glob = String(args.pattern || '*');
      const max = Math.max(1, Math.min(5000, Number(args.max_results) || 200));
      const re = globToRegExp(glob);
      const matches = [];
      const walk = async (cur) => {
        if (matches.length >= max) return;
        let entries = [];
        try { entries = await fs.promises.readdir(cur, { withFileTypes: true }); } catch { return; }
        for (const entry of entries) {
          if (matches.length >= max) return;
          const full = path.join(cur, entry.name);
          if (entry.isDirectory()) {
            await walk(full);
            continue;
          }
          const rel = path.relative(base, full) || entry.name;
          if (re.test(entry.name) || re.test(rel.replace(/\\/g, '/'))) {
            matches.push(full);
          }
        }
      };
      await walk(base);
      const text = matches.join('\n') || `(no files matching ${glob} under ${base})`;
      sendMsg({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], isError: false } });
      return;
    }

    if (name === 'search_files') {
      const base = args.path ? resolveInputPath(args.path) : REAL_ROOTS[0];
      const pattern = String(args.pattern || '');
      const ignoreCase = !!args.ignore_case;
      const max = Math.max(1, Math.min(5000, Number(args.max_results) || 200));
      const glob = args.glob ? String(args.glob) : '';
      const results = [];
      const needle = ignoreCase ? pattern.toLowerCase() : pattern;
      await walkFiles(base, { maxResults: max, ignoreCase, glob, pattern }, async (filePath) => {
        if (results.length >= max) return;
        try {
          const text = await readTextFile(filePath);
          const hay = ignoreCase ? text.toLowerCase() : text;
          if (hay.includes(needle)) {
            results.push(`${filePath}`);
          }
        } catch {}
      });
      const text = results.join('\n') || `(no matches for ${pattern} under ${base})`;
      sendMsg({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], isError: false } });
      return;
    }

    toolError(id, `Unknown tool: ${name}`);
  } catch (err) {
    sendMsg({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `❌ ${err && err.message ? err.message : String(err)}` }], isError: true } });
  }
}

function handleMessage(msg) {
  const { id, method, params } = msg || {};
  if (method === 'initialize') {
    sendMsg({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'pepe_localfs', version: '1.0.0' },
      },
    });
    return;
  }
  if (method === 'notifications/initialized') return;
  if (method === 'tools/list') {
    sendMsg({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    return;
  }
  if (method === 'tools/call') {
    handleCall(id, params?.name, params?.arguments || {});
    return;
  }
  if (id !== undefined) toolError(id, `Unknown method: ${method}`);
}

let inputBuf = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', (chunk) => {
  inputBuf += chunk;
  let idx;
  while ((idx = inputBuf.indexOf('\n')) >= 0) {
    const line = inputBuf.slice(0, idx);
    inputBuf = inputBuf.slice(idx + 1);
    if (!line.trim()) continue;
    try {
      handleMessage(JSON.parse(line));
    } catch {}
  }
});
process.stdin.on('end', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
