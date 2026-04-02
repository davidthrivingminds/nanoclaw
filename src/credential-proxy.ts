/**
 * Credential proxy for container isolation.
 * Containers connect here instead of directly to the Anthropic API.
 * The proxy injects real credentials so containers never see them.
 *
 * Two auth modes:
 *   API key:  Proxy injects x-api-key on every request.
 *   OAuth:    Container CLI exchanges its placeholder token for a temp
 *             API key via /api/oauth/claude_cli/create_api_key.
 *             Proxy injects real OAuth token on that exchange request;
 *             subsequent requests carry the temp key which is valid as-is.
 *
 * Power BI proxy (/powerbi/*):
 *   Forwarded to api.powerbi.com with a service-principal Bearer token
 *   obtained via client credentials grant (POWERBI_TENANT_ID/CLIENT_ID/
 *   CLIENT_SECRET). Token is cached in memory and refreshed 1 min before
 *   expiry. Credentials never enter containers.
 *
 * HubSpot token endpoint (GET /hubspot-token):
 *   Returns {"token":"..."} so container agents can bootstrap the official
 *   @hubspot/mcp-server. The private app access token never enters the
 *   container environment — it's fetched over the bridge network at startup.
 *
 * Excel budget endpoint (/excel-budget):
 *   Reads the XLSX file at POWERBI_EXCEL_PATH and returns all sheets as
 *   JSON. The file path stays on the host; containers only see parsed data.
 */
import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import { request as httpsRequest } from 'https';
import { request as httpRequest, RequestOptions } from 'http';
import fs from 'fs';

import nodemailer from 'nodemailer';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

export type AuthMode = 'api-key' | 'oauth';

export interface ProxyConfig {
  authMode: AuthMode;
}

// Power BI token cache (module-level — shared across all requests)
let pbTokenCache: { value: string; expiresAt: number } | null = null;

async function fetchPowerBIToken(
  tenantId: string,
  clientId: string,
  clientSecret: string,
): Promise<string> {
  const now = Date.now();
  if (pbTokenCache && pbTokenCache.expiresAt > now + 60_000) {
    return pbTokenCache.value;
  }

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
    scope: 'https://analysis.windows.net/powerbi/api/.default',
  }).toString();

  return new Promise((resolve, reject) => {
    const tokenReq = httpsRequest(
      {
        hostname: 'login.microsoftonline.com',
        port: 443,
        path: `/${tenantId}/oauth2/v2.0/token`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          try {
            const data = JSON.parse(Buffer.concat(chunks).toString()) as {
              access_token?: string;
              expires_in?: number;
              error?: string;
              error_description?: string;
            };
            if (!data.access_token) {
              reject(
                new Error(
                  data.error_description ||
                    data.error ||
                    'No access_token in Power BI token response',
                ),
              );
              return;
            }
            pbTokenCache = {
              value: data.access_token,
              expiresAt: now + (data.expires_in ?? 3600) * 1000,
            };
            resolve(data.access_token);
          } catch (err) {
            reject(err);
          }
        });
      },
    );
    tokenReq.on('error', reject);
    tokenReq.write(body);
    tokenReq.end();
  });
}

function handlePowerBIRequest(
  req: IncomingMessage,
  res: ServerResponse,
  body: Buffer,
  token: string,
): void {
  const powerbiPath = (req.url ?? '').slice('/powerbi'.length) || '/v1.0/myorg';
  const headers: Record<string, string | string[] | undefined> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (
      k !== 'host' &&
      k !== 'connection' &&
      k !== 'keep-alive' &&
      k !== 'transfer-encoding'
    ) {
      headers[k] = v as string | string[] | undefined;
    }
  }
  headers['host'] = 'api.powerbi.com';
  headers['authorization'] = `Bearer ${token}`;
  headers['content-length'] = String(body.length);

  const upstream = httpsRequest(
    {
      hostname: 'api.powerbi.com',
      port: 443,
      path: powerbiPath,
      method: req.method,
      headers,
    } as RequestOptions,
    (upRes) => {
      res.writeHead(upRes.statusCode!, upRes.headers);
      upRes.pipe(res);
    },
  );
  upstream.on('error', (err: Error) => {
    logger.error({ err, path: powerbiPath }, 'Power BI upstream error');
    if (!res.headersSent) {
      res.writeHead(502);
      res.end('Power BI upstream error');
    }
  });
  upstream.write(body);
  upstream.end();
}

function handleExcelBudget(res: ServerResponse, excelPath: string): void {
  if (!excelPath) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error: 'POWERBI_EXCEL_PATH not set in .env',
      }),
    );
    return;
  }
  if (!fs.existsSync(excelPath)) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `Excel file not found: ${excelPath}` }));
    return;
  }
  // Dynamic import so startup doesn't fail if xlsx isn't installed yet.
  // xlsx is CJS; when dynamically imported in ESM, exports land on .default.
  import('xlsx')
    .then((mod) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const XLSX = ((mod as any).default || mod) as typeof import('xlsx');
      try {
        const workbook = XLSX.readFile(excelPath);
        const result: Record<
          string,
          { headers: unknown[]; rows: unknown[][] }
        > = {};
        for (const sheetName of workbook.SheetNames) {
          const sheet = workbook.Sheets[sheetName];
          const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
            header: 1,
            defval: null,
          });
          if (rows.length === 0) {
            result[sheetName] = { headers: [], rows: [] };
            continue;
          }
          const [headers, ...dataRows] = rows;
          result[sheetName] = {
            headers: headers as unknown[],
            rows: dataRows.slice(0, 1000),
          };
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ file: excelPath, sheets: result }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: `Failed to read Excel: ${(err as Error).message}`,
          }),
        );
      }
    })
    .catch((err: Error) => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: `xlsx package not available. Run: npm install. Details: ${err.message}`,
        }),
      );
    });
}

export function startCredentialProxy(
  port: number,
  host = '127.0.0.1',
): Promise<Server> {
  const secrets = readEnvFile([
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'POWERBI_TENANT_ID',
    'POWERBI_CLIENT_ID',
    'POWERBI_CLIENT_SECRET',
    'POWERBI_EXCEL_PATH',
    'HUBSPOT_ACCESS_TOKEN',
    'SMTP_HOST',
    'SMTP_PORT',
    'SMTP_USER',
    'SMTP_PASS',
    'ALERT_EMAIL_FROM',
    'ALERT_EMAIL_TO',
  ]);

  const authMode: AuthMode = secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
  const oauthToken =
    secrets.CLAUDE_CODE_OAUTH_TOKEN || secrets.ANTHROPIC_AUTH_TOKEN;

  const upstreamUrl = new URL(
    secrets.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
  );
  const isHttps = upstreamUrl.protocol === 'https:';
  const makeRequest = isHttps ? httpsRequest : httpRequest;

  const pbConfigured = !!(
    secrets.POWERBI_TENANT_ID &&
    secrets.POWERBI_CLIENT_ID &&
    secrets.POWERBI_CLIENT_SECRET
  );
  const excelPath = secrets.POWERBI_EXCEL_PATH || '';

  if (pbConfigured) {
    logger.info('Power BI proxy enabled (service principal auth)');
  }
  if (secrets.HUBSPOT_ACCESS_TOKEN) {
    logger.info('HubSpot token endpoint enabled (private app)');
  }

  const smtpConfigured = !!(
    secrets.SMTP_HOST &&
    secrets.SMTP_USER &&
    secrets.SMTP_PASS &&
    secrets.ALERT_EMAIL_TO
  );
  const smtpTransport = smtpConfigured
    ? nodemailer.createTransport({
        host: secrets.SMTP_HOST,
        port: parseInt(secrets.SMTP_PORT || '587', 10),
        secure: (secrets.SMTP_PORT || '587') === '465',
        auth: { user: secrets.SMTP_USER, pass: secrets.SMTP_PASS },
      })
    : null;
  if (smtpConfigured) {
    logger.info({ host: secrets.SMTP_HOST, user: secrets.SMTP_USER }, 'Email endpoint enabled');
  }

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        void (async () => {
          const body = Buffer.concat(chunks);

          // ── Power BI proxy ──────────────────────────────────────────────
          if (req.url?.startsWith('/powerbi/')) {
            if (!pbConfigured) {
              res.writeHead(503, { 'Content-Type': 'application/json' });
              res.end(
                JSON.stringify({
                  error:
                    'Power BI not configured. Add POWERBI_TENANT_ID, POWERBI_CLIENT_ID, POWERBI_CLIENT_SECRET to .env',
                }),
              );
              return;
            }
            try {
              const token = await fetchPowerBIToken(
                secrets.POWERBI_TENANT_ID!,
                secrets.POWERBI_CLIENT_ID!,
                secrets.POWERBI_CLIENT_SECRET!,
              );
              handlePowerBIRequest(req, res, body, token);
            } catch (err) {
              logger.error({ err }, 'Power BI token fetch failed');
              res.writeHead(502, { 'Content-Type': 'application/json' });
              res.end(
                JSON.stringify({
                  error: `Power BI auth failed: ${(err as Error).message}`,
                }),
              );
            }
            return;
          }

          // ── Excel budget endpoint ────────────────────────────────────────
          if (req.url === '/excel-budget') {
            handleExcelBudget(res, excelPath);
            return;
          }

          // ── HubSpot token endpoint ───────────────────────────────────────
          if (req.url === '/hubspot-token') {
            const hsToken = secrets.HUBSPOT_ACCESS_TOKEN;
            if (!hsToken) {
              res.writeHead(503, { 'Content-Type': 'application/json' });
              res.end(
                JSON.stringify({
                  error: 'HUBSPOT_ACCESS_TOKEN not set in .env',
                }),
              );
              return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ token: hsToken }));
            return;
          }

          // ── Email endpoint ──────────────────────────────────────────────
          if (req.url === '/send-email' && req.method === 'POST') {
            if (!smtpTransport) {
              res.writeHead(503, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({
                error: 'Email not configured. Add SMTP_HOST, SMTP_USER, SMTP_PASS, ALERT_EMAIL_TO to .env',
              }));
              return;
            }
            try {
              const payload = JSON.parse(body.toString()) as {
                subject?: string;
                body?: string;
                to?: string;
              };
              const to = payload.to || secrets.ALERT_EMAIL_TO!;
              const from = secrets.ALERT_EMAIL_FROM || secrets.SMTP_USER!;
              await smtpTransport.sendMail({
                from,
                to,
                subject: payload.subject || '(no subject)',
                text: payload.body || '',
              });
              logger.info({ to, subject: payload.subject }, 'Email sent');
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: true }));
            } catch (err) {
              logger.error({ err }, 'Email send failed');
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: (err as Error).message }));
            }
            return;
          }

          // ── Anthropic API proxy (existing logic) ─────────────────────────
          const headers: Record<
            string,
            string | number | string[] | undefined
          > = {
            ...(req.headers as Record<string, string>),
            host: upstreamUrl.host,
            'content-length': body.length,
          };

          // Strip hop-by-hop headers that must not be forwarded by proxies
          delete headers['connection'];
          delete headers['keep-alive'];
          delete headers['transfer-encoding'];

          if (authMode === 'api-key') {
            // API key mode: inject x-api-key on every request
            delete headers['x-api-key'];
            headers['x-api-key'] = secrets.ANTHROPIC_API_KEY;
          } else {
            // OAuth mode: replace placeholder Bearer token with the real one
            // only when the container actually sends an Authorization header
            // (exchange request + auth probes). Post-exchange requests use
            // x-api-key only, so they pass through without token injection.
            if (headers['authorization']) {
              delete headers['authorization'];
              if (oauthToken) {
                headers['authorization'] = `Bearer ${oauthToken}`;
              }
            }
          }

          const upstream = makeRequest(
            {
              hostname: upstreamUrl.hostname,
              port: upstreamUrl.port || (isHttps ? 443 : 80),
              path: req.url,
              method: req.method,
              headers,
            } as RequestOptions,
            (upRes) => {
              res.writeHead(upRes.statusCode!, upRes.headers);
              upRes.pipe(res);
            },
          );

          upstream.on('error', (err) => {
            logger.error(
              { err, url: req.url },
              'Credential proxy upstream error',
            );
            if (!res.headersSent) {
              res.writeHead(502);
              res.end('Bad Gateway');
            }
          });

          upstream.write(body);
          upstream.end();
        })();
      });
    });

    server.listen(port, host, () => {
      logger.info({ port, host, authMode }, 'Credential proxy started');
      resolve(server);
    });

    server.on('error', reject);
  });
}

/** Detect which auth mode the host is configured for. */
export function detectAuthMode(): AuthMode {
  const secrets = readEnvFile(['ANTHROPIC_API_KEY']);
  return secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
}
