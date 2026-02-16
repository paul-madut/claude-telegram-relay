/**
 * ClickUp Bidirectional Sync
 *
 * Syncs tasks between ClickUp and the agent's Supabase task queue:
 * - ClickUp → Agent: New/updated ClickUp tasks become agent tasks
 * - Agent → ClickUp: Completed agent tasks update ClickUp status + add comment
 * - Recurring tasks: ClickUp tasks tagged "daily" are re-created each day
 *
 * Runs on a 5-minute interval inside the relay process.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  listClickUpTasks,
  getClickUpTask,
  createClickUpTask,
  updateClickUpTask,
  completeClickUpTask,
  addClickUpComment,
  isClickUpConfigured,
  type ClickUpTask,
} from "../tools/clickup.ts";
import { createTask, listTasks, completeTask } from "../tasks.ts";
import type { Task } from "../types.ts";

const SYNC_INTERVAL = 5 * 60_000; // 5 minutes
let syncTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Start the ClickUp sync loop.
 */
export function startClickUpSync(supabase: SupabaseClient): void {
  if (syncTimer) return;

  console.log(
    `[ClickUp Sync] Starting (every ${SYNC_INTERVAL / 1000}s)`
  );

  // Run once immediately, then on interval
  syncTick(supabase).catch((err) =>
    console.error("[ClickUp Sync] Initial sync error:", err)
  );

  syncTimer = setInterval(async () => {
    try {
      await syncTick(supabase);
    } catch (error) {
      console.error("[ClickUp Sync] Tick error:", error);
    }
  }, SYNC_INTERVAL);
}

/**
 * Stop the sync loop.
 */
export function stopClickUpSync(): void {
  if (syncTimer) {
    clearInterval(syncTimer);
    syncTimer = null;
  }
}

/**
 * Single sync tick — pull from ClickUp, push completions back.
 */
async function syncTick(supabase: SupabaseClient): Promise<void> {
  const configured = await isClickUpConfigured();
  if (!configured) return;

  await Promise.all([
    pullFromClickUp(supabase),
    pushToClickUp(supabase),
    handleRecurringTasks(supabase),
  ]);
}

// ============================================================
// PULL: ClickUp → Agent Task Queue
// ============================================================

/**
 * Import open ClickUp tasks into the agent's Supabase queue.
 * Skips tasks that are already tracked (by clickup_id in metadata).
 */
async function pullFromClickUp(supabase: SupabaseClient): Promise<void> {
  const clickUpTasks = await listClickUpTasks(false);
  if (!clickUpTasks.length) return;

  // Get all agent tasks that came from ClickUp
  const { data: existingTasks } = await supabase
    .from("tasks")
    .select("id, metadata")
    .not("metadata->clickup_id", "is", null);

  const trackedIds = new Set(
    (existingTasks || []).map(
      (t: any) => t.metadata?.clickup_id as string
    )
  );

  let imported = 0;
  for (const cuTask of clickUpTasks) {
    if (trackedIds.has(cuTask.id)) continue;

    // Skip tasks in completed/closed status
    const status = cuTask.status.status.toLowerCase();
    if (status === "complete" || status === "done" || status === "closed") {
      continue;
    }

    const tags = cuTask.tags.map((t) => t.name.toLowerCase());

    // Only import tasks tagged "bot" — everything else is user-managed
    if (!tags.includes("bot")) continue;

    const priority = mapClickUpPriority(cuTask.priority?.id);

    await createTask(supabase, {
      title: cuTask.name,
      prompt: buildClickUpTaskPrompt(cuTask),
      description: cuTask.description || undefined,
      priority,
      type: tags.includes("daily") ? "recurring" : "one_shot",
      recurrence: tags.includes("daily") ? "daily" : undefined,
      metadata: {
        clickup_id: cuTask.id,
        clickup_url: cuTask.url,
        clickup_tags: tags,
        source: "clickup",
      },
    });

    imported++;
  }

  if (imported > 0) {
    console.log(`[ClickUp Sync] Imported ${imported} new tasks from ClickUp`);
  }
}

/**
 * Build a prompt for Claude from a ClickUp task.
 */
function buildClickUpTaskPrompt(task: ClickUpTask): string {
  const parts = [task.name];
  if (task.description) {
    parts.push(`\nDescription: ${task.description}`);
  }
  if (task.due_date) {
    const due = new Date(parseInt(task.due_date));
    parts.push(`\nDue: ${due.toLocaleDateString()}`);
  }
  if (task.tags.length) {
    parts.push(`\nTags: ${task.tags.map((t) => t.name).join(", ")}`);
  }
  return parts.join("");
}

/**
 * Map ClickUp priority ID to our numeric priority.
 * ClickUp: 1=urgent, 2=high, 3=normal, 4=low
 * Agent: higher number = higher priority (0=normal, 1=high, 2=urgent)
 */
function mapClickUpPriority(priorityId?: string): number {
  switch (priorityId) {
    case "1":
      return 2; // urgent
    case "2":
      return 1; // high
    case "3":
      return 0; // normal
    case "4":
      return -1; // low
    default:
      return 0;
  }
}

// ============================================================
// PUSH: Agent → ClickUp
// ============================================================

/**
 * Push completed agent tasks back to ClickUp:
 * - Update status to "ready for review" (user marks done themselves)
 * - Add result as a comment
 * - Mark metadata.clickup_synced = true
 */
async function pushToClickUp(supabase: SupabaseClient): Promise<void> {
  // Find completed tasks that came from ClickUp and haven't been synced back
  const { data: completedTasks } = await supabase
    .from("tasks")
    .select("*")
    .eq("status", "completed")
    .not("metadata->clickup_id", "is", null)
    .or("metadata->clickup_synced.is.null,metadata->clickup_synced.eq.false");

  if (!completedTasks?.length) return;

  let synced = 0;
  for (const task of completedTasks as Task[]) {
    const clickupId = task.metadata?.clickup_id as string;
    if (!clickupId) continue;

    // Post result as comment
    if (task.result) {
      const comment = `Agent completed this task:\n\n${task.result.substring(0, 3000)}`;
      await addClickUpComment(clickupId, comment);
    }

    // Set to "ready for review" — user marks done themselves
    await updateClickUpTask(clickupId, { status: "ready for review" });

    // Mark as synced in our DB
    await supabase
      .from("tasks")
      .update({
        metadata: { ...task.metadata, clickup_synced: true },
      })
      .eq("id", task.id);

    synced++;
  }

  if (synced > 0) {
    console.log(`[ClickUp Sync] Pushed ${synced} completions back to ClickUp`);
  }
}

/**
 * Push agent-created tasks (no clickup_id) to ClickUp.
 * These are tasks the bot created itself that should be visible in ClickUp.
 */
export async function pushNewTaskToClickUp(
  supabase: SupabaseClient,
  task: Task
): Promise<void> {
  if (task.metadata?.clickup_id) return; // Already from ClickUp
  if (task.metadata?.source === "clickup") return;

  const configured = await isClickUpConfigured();
  if (!configured) return;

  const cuTask = await createClickUpTask({
    name: task.title,
    description: task.description || task.prompt,
    priority: mapAgentToClickUpPriority(task.priority),
    tags: task.type === "recurring" ? ["daily", "bot-created"] : ["bot-created"],
  });

  if (cuTask) {
    await supabase
      .from("tasks")
      .update({
        metadata: {
          ...task.metadata,
          clickup_id: cuTask.id,
          clickup_url: cuTask.url,
          source: "agent",
        },
      })
      .eq("id", task.id);

    console.log(`[ClickUp Sync] Pushed new task to ClickUp: ${task.title}`);
  }
}

/**
 * Map agent priority back to ClickUp priority.
 * Agent: -1=low, 0=normal, 1=high, 2=urgent
 * ClickUp: 1=urgent, 2=high, 3=normal, 4=low
 */
function mapAgentToClickUpPriority(priority: number): number {
  if (priority >= 2) return 1; // urgent
  if (priority >= 1) return 2; // high
  if (priority <= -1) return 4; // low
  return 3; // normal
}

// ============================================================
// RECURRING TASKS
// ============================================================

/**
 * Handle daily recurring tasks.
 * If a recurring task was completed yesterday (or earlier), create a new instance.
 */
async function handleRecurringTasks(supabase: SupabaseClient): Promise<void> {
  const { data: recurringTasks } = await supabase
    .from("tasks")
    .select("*")
    .eq("type", "recurring")
    .eq("recurrence", "daily")
    .eq("status", "completed");

  if (!recurringTasks?.length) return;

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  let created = 0;
  for (const task of recurringTasks as Task[]) {
    const completedAt = new Date(task.updated_at);
    completedAt.setHours(0, 0, 0, 0);

    // Only recreate if it was completed before today
    if (completedAt >= today) continue;

    // Check we haven't already created today's instance
    const { data: existing } = await supabase
      .from("tasks")
      .select("id")
      .eq("title", task.title)
      .eq("type", "recurring")
      .in("status", ["pending", "running"])
      .limit(1);

    if (existing?.length) continue;

    // Create new instance
    await createTask(supabase, {
      title: task.title,
      prompt: task.prompt,
      description: task.description || undefined,
      type: "recurring",
      recurrence: "daily",
      priority: task.priority,
      tools: task.tools,
      metadata: {
        ...task.metadata,
        clickup_synced: false,
        recurring_from: task.id,
      },
    });

    created++;
  }

  if (created > 0) {
    console.log(
      `[ClickUp Sync] Created ${created} recurring task instances for today`
    );
  }
}
