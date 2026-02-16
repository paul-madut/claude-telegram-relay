/**
 * ClickUp Intent Processing
 *
 * Parses Claude's response for ClickUp action tags and executes them.
 * Tags are stripped from the response before sending to the user.
 *
 * Supported tags:
 *   [CLICKUP_COMPLETE: task name or partial match]
 *   [CLICKUP_CREATE: task name | DESCRIPTION: optional details | PRIORITY: 1-4]
 *   [CLICKUP_UPDATE: task name | STATUS: status name]
 *   [CLICKUP_COMMENT: task name | COMMENT: text to post]
 */

import {
  listClickUpTasks,
  completeClickUpTask,
  createClickUpTask,
  updateClickUpTask,
  addClickUpComment,
  isClickUpConfigured,
  type ClickUpTask,
} from "./tools/clickup.ts";

interface ClickUpActionResult {
  action: string;
  task: string;
  success: boolean;
  detail: string;
}

/**
 * Process ClickUp intent tags in Claude's response.
 * Executes the actions and returns the cleaned response + results summary.
 */
export async function processClickUpIntents(
  response: string
): Promise<{ clean: string; results: ClickUpActionResult[] }> {
  const configured = await isClickUpConfigured();
  if (!configured) return { clean: response, results: [] };

  let clean = response;
  const results: ClickUpActionResult[] = [];

  // [CLICKUP_COMPLETE: task name]
  for (const match of response.matchAll(
    /\[CLICKUP_COMPLETE:\s*(.+?)\]/gi
  )) {
    const searchText = match[1].trim();
    clean = clean.replace(match[0], "");

    const result = await completeByName(searchText);
    results.push(result);
  }

  // [CLICKUP_CREATE: name | DESCRIPTION: desc | PRIORITY: 1-4]
  for (const match of response.matchAll(
    /\[CLICKUP_CREATE:\s*(.+?)(?:\s*\|\s*DESCRIPTION:\s*(.+?))?(?:\s*\|\s*PRIORITY:\s*(\d))?(?:\s*\|\s*TAGS:\s*(.+?))?\]/gi
  )) {
    const name = match[1].trim();
    const description = match[2]?.trim();
    const priority = match[3] ? parseInt(match[3]) : undefined;
    const tags = match[4]?.split(",").map((t) => t.trim());
    clean = clean.replace(match[0], "");

    const task = await createClickUpTask({
      name,
      description,
      priority,
      tags,
    });

    results.push({
      action: "create",
      task: name,
      success: !!task,
      detail: task ? `Created: ${task.url}` : "Failed to create task",
    });
  }

  // [CLICKUP_UPDATE: task name | STATUS: new status]
  for (const match of response.matchAll(
    /\[CLICKUP_UPDATE:\s*(.+?)\s*\|\s*STATUS:\s*(.+?)\]/gi
  )) {
    const searchText = match[1].trim();
    const newStatus = match[2].trim();
    clean = clean.replace(match[0], "");

    const found = await findTask(searchText);
    if (found) {
      const ok = await updateClickUpTask(found.id, { status: newStatus });
      results.push({
        action: "update",
        task: found.name,
        success: ok,
        detail: ok ? `Status → ${newStatus}` : "Failed to update",
      });
    } else {
      results.push({
        action: "update",
        task: searchText,
        success: false,
        detail: "Task not found",
      });
    }
  }

  // [CLICKUP_COMMENT: task name | COMMENT: text]
  for (const match of response.matchAll(
    /\[CLICKUP_COMMENT:\s*(.+?)\s*\|\s*COMMENT:\s*(.+?)\]/gi
  )) {
    const searchText = match[1].trim();
    const comment = match[2].trim();
    clean = clean.replace(match[0], "");

    const found = await findTask(searchText);
    if (found) {
      const ok = await addClickUpComment(found.id, comment);
      results.push({
        action: "comment",
        task: found.name,
        success: ok,
        detail: ok ? "Comment added" : "Failed to add comment",
      });
    } else {
      results.push({
        action: "comment",
        task: searchText,
        success: false,
        detail: "Task not found",
      });
    }
  }

  return { clean: clean.trim(), results };
}

/**
 * Find a ClickUp task by fuzzy name match.
 */
async function findTask(searchText: string): Promise<ClickUpTask | null> {
  const tasks = await listClickUpTasks(true);
  const lower = searchText.toLowerCase();

  // Exact match first
  const exact = tasks.find(
    (t) => t.name.toLowerCase() === lower
  );
  if (exact) return exact;

  // Partial match
  const partial = tasks.find(
    (t) => t.name.toLowerCase().includes(lower) || lower.includes(t.name.toLowerCase())
  );
  return partial || null;
}

/**
 * Set a task to "ready for review" by searching for it by name.
 * The user will mark it fully done themselves.
 */
async function completeByName(searchText: string): Promise<ClickUpActionResult> {
  const found = await findTask(searchText);
  if (!found) {
    return {
      action: "complete",
      task: searchText,
      success: false,
      detail: `No task found matching "${searchText}"`,
    };
  }

  const ok = await updateClickUpTask(found.id, { status: "ready for review" });
  return {
    action: "complete",
    task: found.name,
    success: ok,
    detail: ok ? 'Status → "ready for review"' : "Failed to update status",
  };
}

/**
 * Get a summary of open ClickUp tasks for prompt context.
 */
export async function getClickUpContext(): Promise<string> {
  const configured = await isClickUpConfigured();
  if (!configured) return "";

  try {
    const tasks = await listClickUpTasks(false);
    if (!tasks.length) return "";

    const lines = tasks.map((t) => {
      const priority = t.priority?.priority || "none";
      const due = t.due_date
        ? ` (due ${new Date(parseInt(t.due_date)).toLocaleDateString()})`
        : "";
      const tags = t.tags.length
        ? ` [${t.tags.map((tag) => tag.name).join(", ")}]`
        : "";
      return `- ${t.name} (${t.status.status}, priority: ${priority})${due}${tags}`;
    });

    return "CLICKUP TASKS:\n" + lines.join("\n");
  } catch {
    return "";
  }
}
