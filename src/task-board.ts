/**
 * OneDrive Task Board writer.
 *
 * Maintains two files in TASK_BOARD_PATH:
 *
 *   tasks.json          — live snapshot of all tasks, rewritten on every change
 *   task_audit_log.json — append-only JSON array, one entry per lifecycle event
 *
 * Writes are best-effort: errors are logged but never thrown, so a missing
 * or unsynced OneDrive folder can't crash the host process.
 */
import fs from 'fs';
import path from 'path';

import { logger } from './logger.js';
import { ScheduledTask } from './types.js';

export type TaskAuditEventType =
  | 'created'
  | 'updated'
  | 'paused'
  | 'resumed'
  | 'cancelled'
  | 'executed';

export interface TaskAuditEvent {
  event: TaskAuditEventType;
  task_id: string;
  group_folder?: string;
  details?: Record<string, unknown>;
}

interface AuditLogEntry extends TaskAuditEvent {
  timestamp: string;
}

/** Rewrite tasks.json with the current full task list. */
export function writeTasksJson(
  taskBoardPath: string,
  tasks: ScheduledTask[],
): void {
  const filePath = path.join(taskBoardPath, 'tasks.json');
  try {
    const payload = {
      generated_at: new Date().toISOString(),
      tasks,
    };
    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2) + '\n', 'utf-8');
  } catch (err) {
    logger.warn({ err, filePath }, 'Task Board: failed to write tasks.json');
  }
}

/** Append one entry to task_audit_log.json (reads → push → rewrites). */
export function appendAuditLog(
  taskBoardPath: string,
  event: TaskAuditEvent,
): void {
  const filePath = path.join(taskBoardPath, 'task_audit_log.json');
  try {
    let entries: AuditLogEntry[] = [];
    if (fs.existsSync(filePath)) {
      try {
        entries = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as AuditLogEntry[];
        if (!Array.isArray(entries)) entries = [];
      } catch {
        entries = []; // corrupt file — start fresh rather than crash
      }
    }
    entries.push({ timestamp: new Date().toISOString(), ...event });
    fs.writeFileSync(
      filePath,
      JSON.stringify(entries, null, 2) + '\n',
      'utf-8',
    );
  } catch (err) {
    logger.warn(
      { err, filePath },
      'Task Board: failed to append to task_audit_log.json',
    );
  }
}
