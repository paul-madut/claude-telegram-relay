/**
 * ClickUp Integration
 *
 * REST API client for ClickUp task management.
 * Supports listing, creating, updating, and completing tasks.
 *
 * Required env vars:
 *   CLICKUP_API_KEY — Personal API token from ClickUp Settings → Apps
 *   CLICKUP_LIST_ID — The list ID where tasks live
 */

const CLICKUP_API = "https://api.clickup.com/api/v2";

function getConfig() {
  const apiKey = process.env.CLICKUP_API_KEY || "";
  const listId = process.env.CLICKUP_LIST_ID || "";
  return { apiKey, listId };
}

function headers(): Record<string, string> {
  const { apiKey } = getConfig();
  return {
    Authorization: apiKey,
    "Content-Type": "application/json",
  };
}

// ============================================================
// TYPES
// ============================================================

export interface ClickUpTask {
  id: string;
  name: string;
  description?: string;
  status: { status: string; type: string };
  priority?: { id: string; priority: string };
  due_date?: string | null;
  date_created: string;
  date_updated: string;
  date_done?: string | null;
  tags: Array<{ name: string }>;
  url: string;
}

// ============================================================
// API METHODS
// ============================================================

/**
 * List tasks in the configured list.
 * Handles pagination (100 per page) and includes subtasks.
 */
export async function listClickUpTasks(
  includeCompleted = false
): Promise<ClickUpTask[]> {
  const { listId } = getConfig();
  if (!listId) return [];

  const allTasks: ClickUpTask[] = [];
  let page = 0;

  while (true) {
    const params = new URLSearchParams();
    params.set("page", String(page));
    params.set("subtasks", "true");
    params.set("include_closed", includeCompleted ? "true" : "false");

    const res = await fetch(
      `${CLICKUP_API}/list/${listId}/task?${params.toString()}`,
      { headers: headers() }
    );

    if (!res.ok) {
      console.error("ClickUp list tasks error:", res.status, await res.text());
      return allTasks;
    }

    const data = (await res.json()) as any;
    const tasks = (data.tasks || []) as ClickUpTask[];
    allTasks.push(...tasks);

    // ClickUp returns up to 100 per page; fewer means last page
    if (tasks.length < 100) break;
    page++;
  }

  return allTasks;
}

/**
 * Get a single task by ID.
 */
export async function getClickUpTask(
  taskId: string
): Promise<ClickUpTask | null> {
  const res = await fetch(`${CLICKUP_API}/task/${taskId}`, {
    headers: headers(),
  });

  if (!res.ok) return null;
  return (await res.json()) as ClickUpTask;
}

/**
 * Create a task in the configured list.
 */
export async function createClickUpTask(opts: {
  name: string;
  description?: string;
  priority?: number; // 1=urgent, 2=high, 3=normal, 4=low
  dueDate?: Date;
  tags?: string[];
  status?: string;
}): Promise<ClickUpTask | null> {
  const { listId } = getConfig();
  if (!listId) return null;

  const body: Record<string, unknown> = {
    name: opts.name,
  };

  if (opts.description) body.description = opts.description;
  if (opts.priority) body.priority = opts.priority;
  if (opts.dueDate) {
    body.due_date = opts.dueDate.getTime();
    body.due_date_time = true;
  }
  if (opts.tags) body.tags = opts.tags;
  if (opts.status) body.status = opts.status;

  const res = await fetch(`${CLICKUP_API}/list/${listId}/task`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    console.error("ClickUp create task error:", res.status, await res.text());
    return null;
  }

  return (await res.json()) as ClickUpTask;
}

/**
 * Update a task's status, name, or description.
 */
export async function updateClickUpTask(
  taskId: string,
  updates: {
    name?: string;
    description?: string;
    status?: string;
    priority?: number;
    dueDate?: Date | null;
  }
): Promise<boolean> {
  const body: Record<string, unknown> = {};

  if (updates.name) body.name = updates.name;
  if (updates.description !== undefined)
    body.description = updates.description;
  if (updates.status) body.status = updates.status;
  if (updates.priority) body.priority = updates.priority;
  if (updates.dueDate) {
    body.due_date = updates.dueDate.getTime();
    body.due_date_time = true;
  } else if (updates.dueDate === null) {
    body.due_date = null;
  }

  const res = await fetch(`${CLICKUP_API}/task/${taskId}`, {
    method: "PUT",
    headers: headers(),
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    console.error("ClickUp update task error:", res.status, await res.text());
    return false;
  }

  return true;
}

/**
 * Mark a task as complete by setting its status to "complete".
 * ClickUp uses the status name, which varies by list. Common: "complete", "done", "closed".
 */
export async function completeClickUpTask(
  taskId: string,
  completedStatus = "complete"
): Promise<boolean> {
  return updateClickUpTask(taskId, { status: completedStatus });
}

/**
 * Add a comment to a task (e.g., to post results).
 */
export async function addClickUpComment(
  taskId: string,
  comment: string
): Promise<boolean> {
  const res = await fetch(`${CLICKUP_API}/task/${taskId}/comment`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ comment_text: comment }),
  });

  if (!res.ok) {
    console.error("ClickUp comment error:", res.status, await res.text());
    return false;
  }

  return true;
}

// ============================================================
// DISCOVERY HELPERS
// ============================================================

/**
 * List all workspaces (teams) the user belongs to.
 * Useful during setup to find the right workspace/list IDs.
 */
export async function listWorkspaces(): Promise<
  Array<{ id: string; name: string }>
> {
  const res = await fetch(`${CLICKUP_API}/team`, { headers: headers() });
  if (!res.ok) return [];
  const data = (await res.json()) as any;
  return (data.teams || []).map((t: any) => ({ id: t.id, name: t.name }));
}

/**
 * List all spaces in a workspace.
 */
export async function listSpaces(
  teamId: string
): Promise<Array<{ id: string; name: string }>> {
  const res = await fetch(`${CLICKUP_API}/team/${teamId}/space`, {
    headers: headers(),
  });
  if (!res.ok) return [];
  const data = (await res.json()) as any;
  return (data.spaces || []).map((s: any) => ({ id: s.id, name: s.name }));
}

/**
 * List all lists in a space (includes folderless lists).
 */
export async function listLists(
  spaceId: string
): Promise<Array<{ id: string; name: string }>> {
  // Get folderless lists
  const res = await fetch(`${CLICKUP_API}/space/${spaceId}/list`, {
    headers: headers(),
  });
  if (!res.ok) return [];
  const data = (await res.json()) as any;
  const lists = (data.lists || []).map((l: any) => ({
    id: l.id,
    name: l.name,
  }));

  // Also get lists inside folders
  const foldersRes = await fetch(`${CLICKUP_API}/space/${spaceId}/folder`, {
    headers: headers(),
  });
  if (foldersRes.ok) {
    const foldersData = (await foldersRes.json()) as any;
    for (const folder of foldersData.folders || []) {
      for (const list of folder.lists || []) {
        lists.push({ id: list.id, name: `${folder.name}/${list.name}` });
      }
    }
  }

  return lists;
}

/**
 * Check if ClickUp is configured and the API key works.
 */
export async function isClickUpConfigured(): Promise<boolean> {
  const { apiKey, listId } = getConfig();
  if (!apiKey || !listId) return false;

  try {
    const res = await fetch(`${CLICKUP_API}/team`, { headers: headers() });
    return res.ok;
  } catch {
    return false;
  }
}
