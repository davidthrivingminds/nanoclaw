/**
 * Power BI MCP Server for NanoClaw
 *
 * Stdio MCP server that runs inside agent containers and exposes Power BI
 * data as tools. API calls are made through the NanoClaw credential proxy
 * on the host (NANOCLAW_PROXY_URL), which injects the service-principal
 * Bearer token — so the client secret never enters the container.
 *
 * Tools:
 *   powerbi_list_workspaces  — list accessible workspaces
 *   powerbi_list_datasets    — list datasets in a workspace
 *   powerbi_list_reports     — list reports in a workspace
 *   powerbi_execute_dax      — run a DAX query against a dataset
 *   powerbi_read_budget_excel — read the TMG budget Excel file as JSON
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

// Proxy URL is the NanoClaw credential proxy running on the host.
// ANTHROPIC_BASE_URL is already set in the container to http://{gateway}:3001.
const PROXY_URL = (
  process.env.NANOCLAW_PROXY_URL ||
  process.env.ANTHROPIC_BASE_URL ||
  'http://192.168.64.1:3001'
).replace(/\/$/, '');

const POWERBI_API = `${PROXY_URL}/powerbi/v1.0/myorg`;

async function proxyGet(path: string): Promise<unknown> {
  const url = `${POWERBI_API}${path}`;
  const res = await fetch(url, { method: 'GET' });
  const text = await res.text();
  if (!res.ok) {
    let detail = text;
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string }; message?: string };
      detail = parsed?.error?.message || parsed?.message || text;
    } catch {
      // use raw text
    }
    throw new Error(`Power BI API ${res.status}: ${detail}`);
  }
  return JSON.parse(text);
}

async function proxyPost(path: string, body: unknown): Promise<unknown> {
  const url = `${POWERBI_API}${path}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    let detail = text;
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string }; message?: string };
      detail = parsed?.error?.message || parsed?.message || text;
    } catch {
      // use raw text
    }
    throw new Error(`Power BI API ${res.status}: ${detail}`);
  }
  return JSON.parse(text);
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const server = new McpServer({
  name: 'powerbi',
  version: '1.0.0',
});

// ── powerbi_list_workspaces ──────────────────────────────────────────────────

server.tool(
  'powerbi_list_workspaces',
  'List all Power BI workspaces accessible to the NanoClaw service principal. Run this first to discover workspace IDs needed by other tools.',
  {},
  async () => {
    try {
      const data = (await proxyGet('/groups')) as {
        value?: Array<{ id: string; name: string; type?: string; isOnDedicatedCapacity?: boolean }>;
      };
      const workspaces = data.value ?? [];
      if (workspaces.length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'No workspaces found. Ensure the service principal has been added as a Member to your Power BI workspaces in app.powerbi.com.',
            },
          ],
        };
      }
      const lines = workspaces.map(
        (w) => `• ${w.name}\n  ID: ${w.id}${w.type ? `  Type: ${w.type}` : ''}`,
      );
      return {
        content: [
          {
            type: 'text' as const,
            text: `Power BI workspaces (${workspaces.length}):\n\n${lines.join('\n\n')}`,
          },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${formatError(err)}` }],
        isError: true,
      };
    }
  },
);

// ── powerbi_list_datasets ────────────────────────────────────────────────────

server.tool(
  'powerbi_list_datasets',
  'List datasets in a Power BI workspace. Returns dataset names and IDs needed for DAX queries.',
  {
    workspace_id: z
      .string()
      .describe('Workspace ID from powerbi_list_workspaces'),
  },
  async (args) => {
    try {
      const data = (await proxyGet(
        `/groups/${args.workspace_id}/datasets`,
      )) as {
        value?: Array<{
          id: string;
          name: string;
          configuredBy?: string;
          isRefreshable?: boolean;
          targetStorageMode?: string;
        }>;
      };
      const datasets = data.value ?? [];
      if (datasets.length === 0) {
        return {
          content: [
            { type: 'text' as const, text: 'No datasets found in this workspace.' },
          ],
        };
      }
      const lines = datasets.map(
        (d) =>
          `• ${d.name}\n  ID: ${d.id}${d.configuredBy ? `  Owner: ${d.configuredBy}` : ''}`,
      );
      return {
        content: [
          {
            type: 'text' as const,
            text: `Datasets in workspace (${datasets.length}):\n\n${lines.join('\n\n')}`,
          },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${formatError(err)}` }],
        isError: true,
      };
    }
  },
);

// ── powerbi_list_reports ─────────────────────────────────────────────────────

server.tool(
  'powerbi_list_reports',
  'List reports in a Power BI workspace.',
  {
    workspace_id: z
      .string()
      .describe('Workspace ID from powerbi_list_workspaces'),
  },
  async (args) => {
    try {
      const data = (await proxyGet(
        `/groups/${args.workspace_id}/reports`,
      )) as {
        value?: Array<{
          id: string;
          name: string;
          datasetId?: string;
          webUrl?: string;
        }>;
      };
      const reports = data.value ?? [];
      if (reports.length === 0) {
        return {
          content: [
            { type: 'text' as const, text: 'No reports found in this workspace.' },
          ],
        };
      }
      const lines = reports.map(
        (r) =>
          `• ${r.name}\n  Report ID: ${r.id}${r.datasetId ? `  Dataset ID: ${r.datasetId}` : ''}`,
      );
      return {
        content: [
          {
            type: 'text' as const,
            text: `Reports in workspace (${reports.length}):\n\n${lines.join('\n\n')}`,
          },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${formatError(err)}` }],
        isError: true,
      };
    }
  },
);

// ── powerbi_execute_dax ──────────────────────────────────────────────────────

server.tool(
  'powerbi_execute_dax',
  `Run a DAX query against a Power BI dataset and return the results.

Examples:
  EVALUATE SUMMARIZECOLUMNS('Date'[Month], "Revenue", SUM('Sales'[Revenue]))
  EVALUATE TOPN(10, 'Customers', 'Customers'[TotalSpend], DESC)
  EVALUATE ROW("Total", [Total Revenue])

The dataset must be in an accessible workspace. Use powerbi_list_datasets to find dataset IDs.`,
  {
    dataset_id: z.string().describe('Dataset ID from powerbi_list_datasets'),
    query: z.string().describe('DAX query string (must start with EVALUATE)'),
  },
  async (args) => {
    if (!args.query.trim().toUpperCase().startsWith('EVALUATE')) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'DAX query must start with EVALUATE. Example: EVALUATE SUMMARIZECOLUMNS(...)',
          },
        ],
        isError: true,
      };
    }

    try {
      const data = (await proxyPost(
        `/datasets/${args.dataset_id}/executeQueries`,
        {
          queries: [{ query: args.query }],
          serializerSettings: { includeNulls: true },
        },
      )) as {
        results?: Array<{
          tables?: Array<{
            rows?: Array<Record<string, unknown>>;
          }>;
          error?: { code?: string; pbi_error?: { parameters?: unknown } };
        }>;
        error?: { code?: string; message?: string };
      };

      if (data.error) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Query error: ${data.error.code || ''} ${data.error.message || ''}`.trim(),
            },
          ],
          isError: true,
        };
      }

      const tables = data.results?.[0]?.tables ?? [];
      if (tables.length === 0 || !tables[0]?.rows?.length) {
        return {
          content: [{ type: 'text' as const, text: 'Query returned no rows.' }],
        };
      }

      const rows = tables[0].rows!;
      const totalRows = rows.length;
      const displayRows = rows.slice(0, 200);

      // Clean up column names (Power BI prefixes them with [TableName])
      const headers = Object.keys(displayRows[0]).map((k) =>
        k.replace(/^\[|\]$/g, '').split('][').pop() ?? k,
      );
      const rawKeys = Object.keys(displayRows[0]);

      // Format as a readable table
      const colWidths = headers.map((h, i) => {
        const maxVal = Math.max(
          h.length,
          ...displayRows.map((r) => String(r[rawKeys[i]] ?? '').length),
        );
        return Math.min(maxVal, 30);
      });

      const separator = colWidths.map((w) => '-'.repeat(w)).join(' | ');
      const headerRow = headers
        .map((h, i) => h.slice(0, colWidths[i]).padEnd(colWidths[i]))
        .join(' | ');
      const dataRows = displayRows.map((row) =>
        rawKeys
          .map((k, i) => String(row[k] ?? '').slice(0, colWidths[i]).padEnd(colWidths[i]))
          .join(' | '),
      );

      const truncNote =
        totalRows > 200 ? `\n(Showing 200 of ${totalRows} rows)` : '';

      return {
        content: [
          {
            type: 'text' as const,
            text: `${headerRow}\n${separator}\n${dataRows.join('\n')}${truncNote}`,
          },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${formatError(err)}` }],
        isError: true,
      };
    }
  },
);

// ── powerbi_read_budget_excel ────────────────────────────────────────────────

server.tool(
  'powerbi_read_budget_excel',
  'Read the TMG budget Excel file (Budget_TMG_FY26WIP with extension.xlsx) and return all sheets as structured data. The file is read from the host via the credential proxy.',
  {},
  async () => {
    try {
      const res = await fetch(`${PROXY_URL}/excel-budget`);
      const text = await res.text();
      if (!res.ok) {
        let detail = text;
        try {
          detail = (JSON.parse(text) as { error?: string }).error ?? text;
        } catch {
          // use raw text
        }
        return {
          content: [{ type: 'text' as const, text: `Error reading Excel: ${detail}` }],
          isError: true,
        };
      }

      const data = JSON.parse(text) as {
        file: string;
        sheets: Record<
          string,
          { headers: unknown[]; rows: unknown[][] }
        >;
      };

      const sheetNames = Object.keys(data.sheets);
      const parts: string[] = [`File: ${data.file.split('/').pop()}`];

      for (const name of sheetNames) {
        const sheet = data.sheets[name];
        const rowCount = sheet.rows.length;
        parts.push(`\n## Sheet: ${name} (${rowCount} data rows)`);

        if (sheet.headers.length === 0) {
          parts.push('(empty sheet)');
          continue;
        }

        const headers = sheet.headers.map(String);
        const displayRows = sheet.rows.slice(0, 100);

        // Simple pipe-delimited table
        parts.push(headers.join(' | '));
        parts.push(headers.map((h) => '-'.repeat(Math.min(h.length, 20))).join(' | '));
        for (const row of displayRows) {
          parts.push(
            (row as unknown[]).map((v) => String(v ?? '').slice(0, 40)).join(' | '),
          );
        }
        if (rowCount > 100) {
          parts.push(`... (${rowCount - 100} more rows)`);
        }
      }

      return {
        content: [{ type: 'text' as const, text: parts.join('\n') }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${formatError(err)}` }],
        isError: true,
      };
    }
  },
);

// Start the stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
