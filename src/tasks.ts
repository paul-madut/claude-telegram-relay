/**
 * Task Queue Module
 *
 * CRUD operations for the persistent task queue in Supabase.
 * Tasks are the core unit of autonomous work — each one represents
 * a job for Claude to execute in the background.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Task, TaskStatus } from "./types.ts";

/**
 * Create a new task in the queue.
 */
export async function createTask(
  supabase: SupabaseClient,
  task: {
    title: string;
    prompt: string;
    description?: string;
    type?: "one_shot" | "recurring" | "multi_step";
    tools?: string[];
    priority?: number;
    parent_task_id?: string;
    depends_on?: string[];
    scheduled_for?: string;
    recurrence?: string;
    metadata?: Record<string, unknown>;
  }
): Promise<Task | null> {
  const { data, error } = await supabase
    .from("tasks")
    .insert({
      title: task.title,
      prompt: task.prompt,
      description: task.description || null,
      type: task.type || "one_shot",
      tools: task.tools || [],
      priority: task.priority ?? 0,
      parent_task_id: task.parent_task_id || null,
      depends_on: task.depends_on || [],
      scheduled_for: task.scheduled_for || null,
      recurrence: task.recurrence || null,
      metadata: task.metadata || {},
    })
    .select()
    .single();

  if (error) {
    console.error("Create task error:", error);
    return null;
  }

  return data as Task;
}

/**
 * Atomically claim the next executable task.
 * Returns null if no tasks are ready to run.
 * Uses the get_next_task() RPC for atomic claim with FOR UPDATE SKIP LOCKED.
 */
export async function getNextTask(
  supabase: SupabaseClient
): Promise<Task | null> {
  const { data, error } = await supabase.rpc("get_next_task");

  if (error) {
    console.error("Get next task error:", error);
    return null;
  }

  // RPC returns an array (SETOF), take first element
  const task = Array.isArray(data) ? data[0] : data;
  if (!task || !task.id) return null;

  return task as Task;
}

/**
 * Mark a task as completed with its result.
 */
export async function completeTask(
  supabase: SupabaseClient,
  taskId: string,
  result: string
): Promise<void> {
  const { error } = await supabase
    .from("tasks")
    .update({ status: "completed", result })
    .eq("id", taskId);

  if (error) console.error("Complete task error:", error);
}

/**
 * Mark a task as failed with an error message.
 * Increments retry_count. If under max_retries, resets to pending.
 */
export async function failTask(
  supabase: SupabaseClient,
  taskId: string,
  errorMsg: string
): Promise<void> {
  // Get current retry state
  const { data: task } = await supabase
    .from("tasks")
    .select("retry_count, max_retries")
    .eq("id", taskId)
    .single();

  const retryCount = (task?.retry_count || 0) + 1;
  const maxRetries = task?.max_retries || 3;

  const newStatus: TaskStatus =
    retryCount < maxRetries ? "pending" : "failed";

  const { error } = await supabase
    .from("tasks")
    .update({
      status: newStatus,
      error: errorMsg,
      retry_count: retryCount,
    })
    .eq("id", taskId);

  if (error) console.error("Fail task error:", error);
}

/**
 * Pause a task (e.g., awaiting human approval).
 */
export async function pauseTask(
  supabase: SupabaseClient,
  taskId: string,
  status: "paused" | "awaiting_approval" = "paused"
): Promise<void> {
  const { error } = await supabase
    .from("tasks")
    .update({ status })
    .eq("id", taskId);

  if (error) console.error("Pause task error:", error);
}

/**
 * Resume a paused/awaiting_approval task.
 */
export async function resumeTask(
  supabase: SupabaseClient,
  taskId: string
): Promise<void> {
  const { error } = await supabase
    .from("tasks")
    .update({ status: "pending" })
    .eq("id", taskId);

  if (error) console.error("Resume task error:", error);
}

/**
 * List tasks with optional status filter.
 */
export async function listTasks(
  supabase: SupabaseClient,
  filter?: { status?: TaskStatus; limit?: number }
): Promise<Task[]> {
  let query = supabase
    .from("tasks")
    .select("*")
    .order("priority", { ascending: false })
    .order("created_at", { ascending: true })
    .limit(filter?.limit || 20);

  if (filter?.status) {
    query = query.eq("status", filter.status);
  }

  const { data, error } = await query;

  if (error) {
    console.error("List tasks error:", error);
    return [];
  }

  return (data || []) as Task[];
}

/**
 * Get a single task by ID.
 */
export async function getTask(
  supabase: SupabaseClient,
  taskId: string
): Promise<Task | null> {
  const { data, error } = await supabase
    .from("tasks")
    .select("*")
    .eq("id", taskId)
    .single();

  if (error) {
    console.error("Get task error:", error);
    return null;
  }

  return data as Task;
}

/**
 * Cancel a task (set status to failed with cancellation note).
 */
export async function cancelTask(
  supabase: SupabaseClient,
  taskId: string
): Promise<void> {
  const { error } = await supabase
    .from("tasks")
    .update({ status: "failed", error: "Cancelled by user" })
    .eq("id", taskId);

  if (error) console.error("Cancel task error:", error);
}

/**
 * Create a subtask linked to a parent.
 */
export async function createSubtask(
  supabase: SupabaseClient,
  parentTaskId: string,
  task: {
    title: string;
    prompt: string;
    description?: string;
    tools?: string[];
    priority?: number;
  }
): Promise<Task | null> {
  return createTask(supabase, {
    ...task,
    parent_task_id: parentTaskId,
    depends_on: [parentTaskId],
  });
}
