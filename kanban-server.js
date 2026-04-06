#!/usr/bin/env node
// kanban-server.js — local read/write file server for the TMG Kanban board
//
// Endpoints:
//   GET  /                     — serve TMG_Kanban_Board.html
//   GET  /scheduler            — serve TMG_Scheduler.html
//   GET  /health               — liveness check
//   GET  /files/:filename      — read a board file (allowlisted)
//   PUT  /files/:filename      — write a board file (allowlisted, atomic)

import http from 'http';
import fs from 'fs';
import path from 'path';

const PORT = 8765;
const HOST = '0.0.0.0';
const BOARD_PATH =
  '/Users/clara/Library/CloudStorage/OneDrive-ThrivingMindsGlobal/' +
  '! TMG Drive - TMG AI Workforce/Task_Board';
const HTML_FILE           = '/Users/clara/nanoclaw/TMG_Kanban_Board.html';
const SCHEDULER_HTML_FILE = '/Users/clara/nanoclaw/TMG_Scheduler.html';

// Only these files may be served; only WRITABLE files may be overwritten.
const READABLE = new Set(['kanban.json', 'kanban_audit.json', 'tasks.json', 'task_audit_log.json', 'TMG_Kanban_Board.html']);
const WRITABLE  = new Set(['kanban.json', 'kanban_audit.json']);

function send(res, status, body) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body, null, 2);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(payload);
}

const server = http.createServer((req, res) => {
  const url  = new URL(req.url, `http://${HOST}`);
  const method = req.method.toUpperCase();

  // OPTIONS — preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Methods': 'GET,PUT,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }

  // GET / — serve the Kanban board HTML
  if (method === 'GET' && (url.pathname === '/' || url.pathname === '')) {
    try {
      const html = fs.readFileSync(HTML_FILE, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    } catch (err) {
      return send(res, err.code === 'ENOENT' ? 404 : 500, { error: err.message });
    }
  }

  // GET /scheduler — serve the Scheduler HTML
  if (method === 'GET' && url.pathname === '/scheduler') {
    try {
      const html = fs.readFileSync(SCHEDULER_HTML_FILE, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    } catch (err) {
      return send(res, err.code === 'ENOENT' ? 404 : 500, { error: err.message });
    }
  }

  // GET /health
  if (method === 'GET' && url.pathname === '/health') {
    return send(res, 200, { ok: true, board: BOARD_PATH, port: PORT });
  }

  // All other routes require /files/:filename
  const match = url.pathname.match(/^\/files\/([^/]+)$/);
  if (!match) {
    return send(res, 404, { error: 'Not found' });
  }
  const filename = match[1];

  // ── GET /files/:filename ──────────────────────────────────────────────────
  if (method === 'GET') {
    if (!READABLE.has(filename)) {
      return send(res, 403, { error: `${filename} is not in the read allowlist` });
    }
    const filePath = path.join(BOARD_PATH, filename);
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(content);
    } catch (err) {
      return send(res, err.code === 'ENOENT' ? 404 : 500, { error: err.message });
    }
  }

  // ── PUT /files/:filename ──────────────────────────────────────────────────
  if (method === 'PUT') {
    if (!WRITABLE.has(filename)) {
      return send(res, 403, { error: `${filename} is not in the write allowlist` });
    }

    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('error', err => send(res, 500, { error: err.message }));
    req.on('end', () => {
      // Validate JSON before touching disk
      try {
        JSON.parse(body);
      } catch {
        return send(res, 400, { error: 'Request body is not valid JSON' });
      }

      // Atomic write: write to .tmp then rename so a crash never corrupts the live file
      const filePath = path.join(BOARD_PATH, filename);
      const tmpPath  = filePath + '.tmp';
      try {
        fs.writeFileSync(tmpPath, body, 'utf8');
        fs.renameSync(tmpPath, filePath);
        console.log(`[kanban-server] wrote ${filename} (${body.length} bytes)`);
        return send(res, 200, { ok: true, file: filename, bytes: body.length });
      } catch (err) {
        try { fs.unlinkSync(tmpPath); } catch { /* best effort */ }
        return send(res, 500, { error: err.message });
      }
    });
    return; // response sent inside 'end' handler
  }

  send(res, 405, { error: 'Method not allowed' });
});

server.listen(PORT, HOST, () => {
  console.log(`[kanban-server] http://${HOST}:${PORT}  board: ${BOARD_PATH}`);
});
