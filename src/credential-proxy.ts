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
 *
 * Email endpoint (/send-email):
 *   Sends email via Microsoft Graph API using the same service principal
 *   credentials as Power BI. No SMTP required.
 *
 * Graph Calendar endpoint (/graph-calendar):
 *   Returns calendar events for an authorised mailbox via Microsoft Graph.
 *   Pass ?mailbox=user@domain.com — returns next 7 days of events.
 *
 * Graph Mail endpoint (/graph-mail):
 *   Returns messages from an authorised mailbox via Microsoft Graph.
 *   Pass ?mailbox=user@domain.com&folder=inbox&top=20
 *   Only authorised mailboxes are permitted — others return 403.
 */
import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import { request as httpsRequest } from 'https';
import { request as httpRequest, RequestOptions } from 'http';
import fs from 'fs';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

export type AuthMode = 'api-key' | 'oauth';

export interface ProxyConfig {
  authMode: AuthMode;
}

// Power BI token cache (module-level — shared across all requests)
let pbTokenCache: { value: string; expiresAt: number } | null = null;

// Graph token cache — 50-minute TTL (tokens valid 60 min, refresh 10 min early)
let graphTokenCache: { value: string; expiresAt: number } | null = null;

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

async function fetchGraphToken(
  tenantId: string,
  clientId: string,
  clientSecret: string,
): Promise<string> {
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
    scope: 'https://graph.microsoft.com/.default',
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
      (r) => {
        const c: Buffer[] = [];
        r.on('data', (d: Buffer) => c.push(d));
        r.on('end', () => {
          const d = JSON.parse(Buffer.concat(c).toString()) as {
            access_token?: string;
            error_description?: string;
          };
          if (!d.access_token)
            reject(new Error(d.error_description || 'No Graph token'));
          else resolve(d.access_token);
        });
      },
    );
    tokenReq.on('error', reject);
    tokenReq.write(body);
    tokenReq.end();
  });
}

async function fetchGraphTokenCached(
  tenantId: string,
  clientId: string,
  clientSecret: string,
): Promise<string> {
  const now = Date.now();
  if (graphTokenCache && graphTokenCache.expiresAt > now + 60_000) {
    return graphTokenCache.value;
  }
  const token = await fetchGraphToken(tenantId, clientId, clientSecret);
  graphTokenCache = { value: token, expiresAt: now + 50 * 60 * 1000 };
  return token;
}

async function fetchGraphData(token: string, path: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const graphReq = httpsRequest(
      {
        hostname: 'graph.microsoft.com',
        port: 443,
        path,
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      },
      (r) => {
        const c: Buffer[] = [];
        r.on('data', (d: Buffer) => c.push(d));
        r.on('end', () => {
          try {
            const parsed = JSON.parse(Buffer.concat(c).toString()) as unknown;
            if (r.statusCode && r.statusCode >= 200 && r.statusCode < 300) {
              resolve(parsed);
            } else {
              reject(
                new Error(
                  `Graph API ${r.statusCode}: ${JSON.stringify(parsed)}`,
                ),
              );
            }
          } catch (err) {
            reject(err);
          }
        });
      },
    );
    graphReq.on('error', reject);
    graphReq.end();
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

  const graphEmailConfigured = !!(
    secrets.POWERBI_TENANT_ID &&
    secrets.POWERBI_CLIENT_ID &&
    secrets.POWERBI_CLIENT_SECRET &&
    secrets.ALERT_EMAIL_FROM &&
    secrets.ALERT_EMAIL_TO
  );
  if (graphEmailConfigured) {
    logger.info(
      { from: secrets.ALERT_EMAIL_FROM },
      'Email endpoint enabled (Microsoft Graph)',
    );
    logger.info('Graph calendar endpoint enabled');
    logger.info('Graph mail endpoint enabled');
  }

  const authorisedMailboxes = [
    'david@thrivingmindsglobal.com',
    'clara@thrivingmindsglobal.com',
    'info@thrivingmindsglobal.com',
    'accounts@thrivingmindsglobal.com',
  ];

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

          // ── Email endpoint (Microsoft Graph) ────────────────────────────
          if (req.url === '/send-email' && req.method === 'POST') {
            if (!graphEmailConfigured) {
              res.writeHead(503, { 'Content-Type': 'application/json' });
              res.end(
                JSON.stringify({
                  error:
                    'Email not configured. Ensure POWERBI_TENANT_ID, POWERBI_CLIENT_ID, POWERBI_CLIENT_SECRET, ALERT_EMAIL_FROM, ALERT_EMAIL_TO are set in .env',
                }),
              );
              return;
            }
            try {
              const payload = JSON.parse(body.toString()) as {
                subject?: string;
                body?: string;
                to?: string;
              };
              const to = payload.to || secrets.ALERT_EMAIL_TO!;
              const from = secrets.ALERT_EMAIL_FROM!;

              const graphToken = await fetchGraphToken(
                secrets.POWERBI_TENANT_ID!,
                secrets.POWERBI_CLIENT_ID!,
                secrets.POWERBI_CLIENT_SECRET!,
              );

              const mailPayload = JSON.stringify({
                message: {
                  subject: payload.subject || '(no subject)',
                  body: { contentType: 'Text', content: payload.body || '' },
                  toRecipients: [{ emailAddress: { address: to } }],
                },
                saveToSentItems: true,
              });
              await new Promise<void>((resolve, reject) => {
                const sendReq = httpsRequest(
                  {
                    hostname: 'graph.microsoft.com',
                    port: 443,
                    path: `/v1.0/users/${from}/sendMail`,
                    method: 'POST',
                    headers: {
                      Authorization: `Bearer ${graphToken}`,
                      'Content-Type': 'application/json',
                      'Content-Length': Buffer.byteLength(mailPayload),
                    },
                  },
                  (r) => {
                    const c: Buffer[] = [];
                    r.on('data', (d: Buffer) => c.push(d));
                    r.on('end', () => {
                      if (
                        r.statusCode &&
                        r.statusCode >= 200 &&
                        r.statusCode < 300
                      ) {
                        resolve();
                      } else {
                        reject(
                          new Error(
                            `Graph sendMail ${r.statusCode}: ${Buffer.concat(c).toString()}`,
                          ),
                        );
                      }
                    });
                  },
                );
                sendReq.on('error', reject);
                sendReq.write(mailPayload);
                sendReq.end();
              });

              logger.info(
                { to, subject: payload.subject },
                'Email sent via Microsoft Graph',
              );
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: true }));
            } catch (err) {
              logger.error({ err }, 'Email send failed');
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: (err as Error).message }));
            }
            return;
          }

          // ── Graph Calendar endpoint ──────────────────────────────────────
          if (req.url?.startsWith('/graph-calendar') && req.method === 'GET') {
            if (!graphEmailConfigured) {
              res.writeHead(503, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Graph not configured.' }));
              return;
            }
            try {
              const urlObj = new URL(req.url, 'http://localhost');
              const mailbox = urlObj.searchParams.get('mailbox');
              if (!mailbox) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(
                  JSON.stringify({ error: 'mailbox query parameter required' }),
                );
                return;
              }
              if (!authorisedMailboxes.includes(mailbox.toLowerCase())) {
                res.writeHead(403, { 'Content-Type': 'application/json' });
                res.end(
                  JSON.stringify({
                    error: `Mailbox ${mailbox} is not on the authorised list.`,
                  }),
                );
                return;
              }

              const graphToken = await fetchGraphToken(
                secrets.POWERBI_TENANT_ID!,
                secrets.POWERBI_CLIENT_ID!,
                secrets.POWERBI_CLIENT_SECRET!,
              );

              const days = Math.min(
                parseInt(urlObj.searchParams.get('days') || '7', 10),
                90,
              );
              const top = Math.min(
                parseInt(urlObj.searchParams.get('top') || '50', 10),
                100,
              );
              const now = new Date();
              const endDate = new Date(
                now.getTime() + days * 24 * 60 * 60 * 1000,
              );
              const startDT = now.toISOString();
              const endDT = endDate.toISOString();
              const calPath = `/v1.0/users/${encodeURIComponent(mailbox)}/calendarView?startDateTime=${startDT}&endDateTime=${endDT}&$select=subject,start,end,location,organizer,attendees,bodyPreview&$orderby=start/dateTime&$top=${top}`;

              const calData = await fetchGraphData(graphToken, calPath);
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify(calData));
            } catch (err) {
              logger.error({ err }, 'Graph calendar fetch failed');
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: (err as Error).message }));
            }
            return;
          }

          // ── Read inbox endpoint ──────────────────────────────────────────
          if (req.url?.startsWith('/read-inbox') && req.method === 'GET') {
            if (!graphEmailConfigured) {
              res.writeHead(503, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Graph not configured.' }));
              return;
            }
            try {
              const urlObj = new URL(req.url, 'http://localhost');
              const count = Math.min(
                parseInt(urlObj.searchParams.get('count') || '20', 10),
                50,
              );
              const mailbox = 'david@thrivingmindsglobal.com';

              const graphToken = await fetchGraphTokenCached(
                secrets.POWERBI_TENANT_ID!,
                secrets.POWERBI_CLIENT_ID!,
                secrets.POWERBI_CLIENT_SECRET!,
              );

              const inboxPath = `/v1.0/users/${encodeURIComponent(mailbox)}/mailFolders/inbox/messages?$select=id,subject,from,receivedDateTime,bodyPreview,isRead,conversationId&$orderby=receivedDateTime%20desc&$top=${count}`;
              const sentPath = `/v1.0/users/${encodeURIComponent(mailbox)}/mailFolders/sentitems/messages?$select=id,conversationId,sentDateTime&$orderby=sentDateTime%20desc&$top=100`;

              const [inboxData, sentData] = await Promise.all([
                fetchGraphData(graphToken, inboxPath),
                fetchGraphData(graphToken, sentPath),
              ]);

              type GraphMessage = {
                id: string;
                subject: string;
                from: { emailAddress: { name: string; address: string } };
                receivedDateTime: string;
                bodyPreview: string;
                isRead: boolean;
                conversationId: string;
              };
              type SentMessage = { conversationId: string };

              const repliedConversations = new Set<string>(
                (sentData as { value?: SentMessage[] }).value?.map(
                  (m) => m.conversationId,
                ) ?? [],
              );

              const now = Date.now();
              const emails = (
                (inboxData as { value?: GraphMessage[] }).value ?? []
              ).map((m) => {
                const ageMs = now - new Date(m.receivedDateTime).getTime();
                const ageHours = ageMs / (1000 * 60 * 60);
                return {
                  id: m.id,
                  subject: m.subject,
                  from: m.from.emailAddress.address,
                  fromName: m.from.emailAddress.name,
                  date: m.receivedDateTime,
                  snippet: m.bodyPreview,
                  isRead: m.isRead,
                  conversationId: m.conversationId,
                  unreplied:
                    ageHours > 24 &&
                    !repliedConversations.has(m.conversationId),
                  ageHours: Math.round(ageHours * 10) / 10,
                };
              });

              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(
                JSON.stringify({
                  emails,
                  unreadCount: emails.filter((e) => !e.isRead).length,
                  unrepliedCount: emails.filter((e) => e.unreplied).length,
                }),
              );
            } catch (err) {
              logger.error({ err }, 'Read inbox failed');
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: (err as Error).message }));
            }
            return;
          }

          // ── Read email endpoint ──────────────────────────────────────────
          if (req.url?.startsWith('/read-email') && req.method === 'GET') {
            if (!graphEmailConfigured) {
              res.writeHead(503, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Graph not configured.' }));
              return;
            }
            try {
              const urlObj = new URL(req.url, 'http://localhost');
              const id = urlObj.searchParams.get('id');
              if (!id) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(
                  JSON.stringify({ error: 'id query parameter required' }),
                );
                return;
              }
              const mailbox = 'david@thrivingmindsglobal.com';
              const graphToken = await fetchGraphTokenCached(
                secrets.POWERBI_TENANT_ID!,
                secrets.POWERBI_CLIENT_ID!,
                secrets.POWERBI_CLIENT_SECRET!,
              );
              const emailPath = `/v1.0/users/${encodeURIComponent(mailbox)}/messages/${encodeURIComponent(id)}?$select=id,subject,from,toRecipients,ccRecipients,receivedDateTime,body,isRead,conversationId`;
              const emailData = await fetchGraphData(graphToken, emailPath);
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify(emailData));
            } catch (err) {
              logger.error({ err }, 'Read email failed');
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: (err as Error).message }));
            }
            return;
          }

          // ── Graph Mail endpoint ──────────────────────────────────────────
          if (req.url?.startsWith('/graph-mail') && req.method === 'GET') {
            if (!graphEmailConfigured) {
              res.writeHead(503, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Graph not configured.' }));
              return;
            }
            try {
              const urlObj = new URL(req.url, 'http://localhost');
              const mailbox = urlObj.searchParams.get('mailbox');
              const folder = urlObj.searchParams.get('folder') || 'inbox';
              const top = urlObj.searchParams.get('top') || '20';

              if (!mailbox) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(
                  JSON.stringify({ error: 'mailbox query parameter required' }),
                );
                return;
              }
              if (!authorisedMailboxes.includes(mailbox.toLowerCase())) {
                res.writeHead(403, { 'Content-Type': 'application/json' });
                res.end(
                  JSON.stringify({
                    error: `Mailbox ${mailbox} is not on the authorised list.`,
                  }),
                );
                return;
              }

              const graphToken = await fetchGraphToken(
                secrets.POWERBI_TENANT_ID!,
                secrets.POWERBI_CLIENT_ID!,
                secrets.POWERBI_CLIENT_SECRET!,
              );

              const mailPath = `/v1.0/users/${encodeURIComponent(mailbox)}/mailFolders/${folder}/messages?$select=subject,from,receivedDateTime,bodyPreview,isRead&$orderby=receivedDateTime%20desc&$top=${top}`;
              const mailData = await fetchGraphData(graphToken, mailPath);
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify(mailData));
            } catch (err) {
              logger.error({ err }, 'Graph mail fetch failed');
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: (err as Error).message }));
            }
            return;
          }

          // ── Anthropic API proxy ──────────────────────────────────────────
          const headers: Record<
            string,
            string | number | string[] | undefined
          > = {
            ...(req.headers as Record<string, string>),
            host: upstreamUrl.host,
            'content-length': body.length,
          };

          delete headers['connection'];
          delete headers['keep-alive'];
          delete headers['transfer-encoding'];

          if (authMode === 'api-key') {
            delete headers['x-api-key'];
            headers['x-api-key'] = secrets.ANTHROPIC_API_KEY;
          } else {
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
