/**
 * M365 Email MCP Server for NanoClaw
 *
 * Stdio MCP server that runs inside agent containers and exposes
 * David's M365 inbox as tools. Reads are made through the NanoClaw
 * credential proxy on the host (/read-inbox, /read-email), which injects
 * the service-principal Bearer token — credentials never enter the container.
 *
 * Tools:
 *   m365_list_inbox      — list recent emails with sender, subject, date, snippet
 *   m365_get_email       — fetch full body of a specific email by ID
 *   m365_list_unreplied           — emails older than N hours with no reply sent
 *   m365_list_calendar_events     — upcoming events for david@thrivingmindsglobal.com
 *   m365_list_clara_calendar_events — upcoming events for clara@thrivingmindsglobal.com
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const PROXY_URL = (
  process.env.NANOCLAW_PROXY_URL ||
  process.env.ANTHROPIC_BASE_URL ||
  'http://192.168.64.1:3001'
).replace(/\/$/, '');

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

interface InboxEmail {
  id: string;
  subject: string;
  from: string;
  fromName: string;
  date: string;
  snippet: string;
  isRead: boolean;
  conversationId: string;
  unreplied: boolean;
  ageHours: number;
}

interface InboxResponse {
  emails: InboxEmail[];
  unreadCount: number;
  unrepliedCount: number;
}

async function fetchInbox(count: number): Promise<InboxResponse> {
  const url = `${PROXY_URL}/read-inbox?count=${count}`;
  const res = await fetch(url);
  const text = await res.text();
  if (!res.ok) {
    let detail = text;
    try {
      const parsed = JSON.parse(text) as { error?: string };
      detail = parsed.error || text;
    } catch { /* use raw */ }
    throw new Error(`M365 /read-inbox ${res.status}: ${detail}`);
  }
  return JSON.parse(text) as InboxResponse;
}

function formatEmail(e: InboxEmail, index?: number): string {
  const prefix = index !== undefined ? `${index + 1}. ` : '';
  const unread = e.isRead ? '' : ' [UNREAD]';
  const unreplied = e.unreplied ? ` [NO REPLY — ${e.ageHours}h old]` : '';
  const fromStr = e.fromName ? `${e.fromName} <${e.from}>` : e.from;
  const date = new Date(e.date).toLocaleString('en-AU', {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  });
  return [
    `${prefix}${e.subject}${unread}${unreplied}`,
    `   From: ${fromStr}`,
    `   Date: ${date}`,
    `   ID:   ${e.id}`,
    `   ${e.snippet.slice(0, 160).replace(/\n/g, ' ')}`,
  ].join('\n');
}

const server = new McpServer({
  name: 'm365',
  version: '1.0.0',
});

// ── m365_list_inbox ────────────────────────────────────────────────────────
server.tool(
  'm365_list_inbox',
  'List recent emails from David\'s M365 inbox. Returns sender, subject, date, snippet, read status, and whether a reply has been sent. Use m365_get_email to read the full body of any email.',
  {
    count: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .describe('Number of emails to return (default 20, max 50)'),
  },
  async (args) => {
    try {
      const data = await fetchInbox(args.count ?? 20);
      if (data.emails.length === 0) {
        return { content: [{ type: 'text' as const, text: 'Inbox is empty.' }] };
      }

      const lines: string[] = [
        `Inbox — ${data.emails.length} emails (${data.unreadCount} unread, ${data.unrepliedCount} unreplied >24h)`,
        '',
      ];
      for (let i = 0; i < data.emails.length; i++) {
        lines.push(formatEmail(data.emails[i], i));
        lines.push('');
      }

      return { content: [{ type: 'text' as const, text: lines.join('\n').trimEnd() }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${formatError(err)}` }],
        isError: true,
      };
    }
  },
);

// ── m365_get_email ────────────────────────────────────────────────────────
server.tool(
  'm365_get_email',
  'Fetch the full content of a specific email from David\'s inbox by its ID. Returns subject, from, to, cc, date, and the complete body. Get IDs from m365_list_inbox.',
  {
    id: z.string().describe('Email message ID from m365_list_inbox'),
  },
  async (args) => {
    try {
      const url = `${PROXY_URL}/read-email?id=${encodeURIComponent(args.id)}`;
      const res = await fetch(url);
      const text = await res.text();
      if (!res.ok) {
        let detail = text;
        try {
          const parsed = JSON.parse(text) as { error?: string };
          detail = parsed.error || text;
        } catch { /* use raw */ }
        throw new Error(`M365 /read-email ${res.status}: ${detail}`);
      }

      const email = JSON.parse(text) as {
        subject?: string;
        from?: { emailAddress?: { name?: string; address?: string } };
        toRecipients?: Array<{ emailAddress?: { name?: string; address?: string } }>;
        ccRecipients?: Array<{ emailAddress?: { name?: string; address?: string } }>;
        receivedDateTime?: string;
        body?: { content?: string; contentType?: string };
        isRead?: boolean;
      };

      const from = email.from?.emailAddress;
      const fromStr = from?.name ? `${from.name} <${from.address}>` : (from?.address ?? '');
      const toStr = (email.toRecipients ?? [])
        .map((r) => r.emailAddress?.name ? `${r.emailAddress.name} <${r.emailAddress.address}>` : r.emailAddress?.address ?? '')
        .join(', ');
      const ccStr = (email.ccRecipients ?? [])
        .map((r) => r.emailAddress?.name ? `${r.emailAddress.name} <${r.emailAddress.address}>` : r.emailAddress?.address ?? '')
        .join(', ');
      const date = email.receivedDateTime
        ? new Date(email.receivedDateTime).toLocaleString('en-AU', {
            weekday: 'short', day: 'numeric', month: 'short',
            year: 'numeric', hour: '2-digit', minute: '2-digit',
          })
        : '';

      // Strip HTML tags for plain-text readability
      const rawBody = email.body?.content ?? '';
      const bodyText = email.body?.contentType === 'html'
        ? rawBody.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
                 .replace(/<[^>]+>/g, '')
                 .replace(/&nbsp;/g, ' ')
                 .replace(/&amp;/g, '&')
                 .replace(/&lt;/g, '<')
                 .replace(/&gt;/g, '>')
                 .replace(/&quot;/g, '"')
                 .replace(/\n{3,}/g, '\n\n')
                 .trim()
        : rawBody.trim();

      const lines = [
        `Subject: ${email.subject ?? ''}`,
        `From:    ${fromStr}`,
        `To:      ${toStr}`,
        ...(ccStr ? [`CC:      ${ccStr}`] : []),
        `Date:    ${date}`,
        `Read:    ${email.isRead ? 'Yes' : 'No'}`,
        '',
        '---',
        '',
        bodyText,
      ];

      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${formatError(err)}` }],
        isError: true,
      };
    }
  },
);

// ── m365_list_unreplied ───────────────────────────────────────────────────
server.tool(
  'm365_list_unreplied',
  'List emails in David\'s inbox that are older than a threshold (default 24 hours) and have not had a reply sent from the mailbox. Useful for identifying emails that need follow-up.',
  {
    min_hours: z
      .number()
      .min(1)
      .optional()
      .describe('Minimum age in hours to flag as unreplied (default 24)'),
    count: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .describe('Number of inbox emails to scan (default 50)'),
  },
  async (args) => {
    try {
      const minHours = args.min_hours ?? 24;
      const data = await fetchInbox(args.count ?? 50);

      // Re-apply threshold in case user passes a different value than 24h
      const unreplied = data.emails.filter((e) => e.ageHours >= minHours && e.unreplied);

      if (unreplied.length === 0) {
        return {
          content: [{
            type: 'text' as const,
            text: `No unreplied emails older than ${minHours} hours.`,
          }],
        };
      }

      const lines: string[] = [
        `${unreplied.length} email${unreplied.length === 1 ? '' : 's'} older than ${minHours}h with no reply:`,
        '',
      ];
      for (let i = 0; i < unreplied.length; i++) {
        lines.push(formatEmail(unreplied[i], i));
        lines.push('');
      }

      return { content: [{ type: 'text' as const, text: lines.join('\n').trimEnd() }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${formatError(err)}` }],
        isError: true,
      };
    }
  },
);

// ── calendar helpers ──────────────────────────────────────────────────────

interface CalendarEvent {
  subject?: string;
  start?: { dateTime?: string; timeZone?: string };
  end?: { dateTime?: string; timeZone?: string };
  location?: { displayName?: string };
  organizer?: { emailAddress?: { name?: string; address?: string } };
  bodyPreview?: string;
}

function formatEvent(e: CalendarEvent, index: number): string {
  const fmt = (dt?: string) => {
    if (!dt) return '?';
    return new Date(dt).toLocaleString('en-AU', {
      weekday: 'short', day: 'numeric', month: 'short',
      hour: '2-digit', minute: '2-digit',
    });
  };
  const organizer = e.organizer?.emailAddress?.name || e.organizer?.emailAddress?.address || '';
  const location = e.location?.displayName ? `\n   Where: ${e.location.displayName}` : '';
  const org = organizer ? `\n   Organiser: ${organizer}` : '';
  return [
    `${index + 1}. ${e.subject ?? '(no subject)'}`,
    `   Start: ${fmt(e.start?.dateTime)}`,
    `   End:   ${fmt(e.end?.dateTime)}${location}${org}`,
  ].join('\n');
}

async function fetchCalendarEvents(
  mailbox: string,
  days: number,
): Promise<CalendarEvent[]> {
  const params = new URLSearchParams({
    mailbox,
    days: String(days),
    top: '50',
  });
  const url = `${PROXY_URL}/graph-calendar?${params}`;
  const res = await fetch(url);
  const text = await res.text();
  if (!res.ok) {
    let detail = text;
    try {
      const parsed = JSON.parse(text) as { error?: string };
      detail = parsed.error || text;
    } catch { /* use raw */ }
    throw new Error(`M365 /graph-calendar ${res.status}: ${detail}`);
  }
  const data = JSON.parse(text) as { value?: CalendarEvent[] };
  return data.value ?? [];
}

// ── m365_list_calendar_events ─────────────────────────────────────────────
server.tool(
  'm365_list_calendar_events',
  "List upcoming calendar events for david@thrivingmindsglobal.com. Returns subject, start/end times, location, and organiser for each event.",
  {
    days: z
      .number()
      .int()
      .min(1)
      .max(90)
      .optional()
      .describe('Number of days ahead to look (default 7, max 90)'),
  },
  async (args) => {
    try {
      const days = args.days ?? 7;
      const events = await fetchCalendarEvents('david@thrivingmindsglobal.com', days);
      if (events.length === 0) {
        return { content: [{ type: 'text' as const, text: `No calendar events in the next ${days} day${days === 1 ? '' : 's'}.` }] };
      }
      const lines = [
        `David's calendar — next ${days} day${days === 1 ? '' : 's'} (${events.length} event${events.length === 1 ? '' : 's'}):`,
        '',
        ...events.flatMap((e, i) => [formatEvent(e, i), '']),
      ];
      return { content: [{ type: 'text' as const, text: lines.join('\n').trimEnd() }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${formatError(err)}` }],
        isError: true,
      };
    }
  },
);

// ── m365_list_clara_calendar_events ──────────────────────────────────────
server.tool(
  'm365_list_clara_calendar_events',
  "List upcoming calendar events for clara@thrivingmindsglobal.com (Clara's own workforce calendar). Returns subject, start/end times, location, and organiser.",
  {
    days: z
      .number()
      .int()
      .min(1)
      .max(90)
      .optional()
      .describe('Number of days ahead to look (default 7, max 90)'),
  },
  async (args) => {
    try {
      const days = args.days ?? 7;
      const events = await fetchCalendarEvents('clara@thrivingmindsglobal.com', days);
      if (events.length === 0) {
        return { content: [{ type: 'text' as const, text: `No calendar events in the next ${days} day${days === 1 ? '' : 's'}.` }] };
      }
      const lines = [
        `Clara's calendar — next ${days} day${days === 1 ? '' : 's'} (${events.length} event${events.length === 1 ? '' : 's'}):`,
        '',
        ...events.flatMap((e, i) => [formatEvent(e, i), '']),
      ];
      return { content: [{ type: 'text' as const, text: lines.join('\n').trimEnd() }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${formatError(err)}` }],
        isError: true,
      };
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
