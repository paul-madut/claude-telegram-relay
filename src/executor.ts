/**
 * Autonomous Task Executor
 *
 * The background engine that picks tasks from the queue and executes them
 * by spawning Claude CLI. Runs inside the relay process on a 30s interval.
 *
 * Flow:
 * 1. getNextTask() claims a pending task atomically
 * 2. Build prompt with task details, memory, profile, and tool instructions
 * 3. Spawn Claude CLI
 * 4. Parse result for intent tags ([TASK_RESULT], [NEEDS_APPROVAL], [SUBTASK])
 * 5. Complete/fail task and notify via Discord
 */

import { spawn } from "bun";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Task, ParsedTaskResult } from "./types.ts";
import {
  CLAUDE_PATH,
  PROJECT_DIR,
  USER_NAME,
  USER_TIMEZONE,
  BOT_TOKEN,
  supabase,
  getProfileContext,
} from "./config.ts";
import {
  getNextTask,
  completeTask,
  failTask,
  pauseTask,
  createTask,
} from "./tasks.ts";
import { getMemoryContext, getRelevantContext } from "./memory.ts";
import { notifyUser } from "./discord-helpers.ts";
import { pushNewTaskToClickUp } from "./sync/clickup-sync.ts";

let isExecuting = false;

/**
 * Main execution loop. Call this on an interval (e.g., every 30s).
 * Only one task runs at a time.
 */
export async function executionTick(): Promise<void> {
  if (isExecuting || !supabase) return;

  const task = await getNextTask(supabase);
  if (!task) return;

  // Only execute tasks tagged for the bot
  const isBotTask =
    task.metadata?.bot_executable === true ||
    (Array.isArray(task.metadata?.clickup_tags) &&
      (task.metadata.clickup_tags as string[]).includes("bot")) ||
    task.metadata?.source === "discord" ||
    task.parent_task_id; // subtasks inherit executability

  if (!isBotTask) {
    // Put it back as pending so it doesn't block the queue
    await supabase
      .from("tasks")
      .update({ status: "pending" })
      .eq("id", task.id);
    return;
  }

  isExecuting = true;
  console.log(`[Executor] Starting task: ${task.title} (${task.id})`);

  try {
    // Build context
    const [memoryContext, relevantContext] = await Promise.all([
      getMemoryContext(supabase),
      getRelevantContext(supabase, task.title + " " + (task.description || "")),
    ]);

    const prompt = buildTaskPrompt(task, memoryContext, relevantContext);

    // Spawn Claude CLI
    const result = await callClaudeForTask(prompt, task.session_id);

    // Parse result for intent tags
    const parsed = parseTaskResult(result);

    if (parsed.needsApproval) {
      await pauseTask(supabase, task.id, "awaiting_approval");
      await notifyUser(
        BOT_TOKEN,
        `**Task needs approval:** ${task.title}\n\n${parsed.approvalPrompt || parsed.response.substring(0, 500)}`
      );
      console.log(`[Executor] Task paused for approval: ${task.title}`);
    } else {
      await completeTask(supabase, task.id, parsed.response);
      await notifyUser(
        BOT_TOKEN,
        `**Task completed:** ${task.title}\n\n${parsed.response.substring(0, 1500)}`
      );
      console.log(`[Executor] Task completed: ${task.title}`);
    }

    // Create any follow-up subtasks
    for (const sub of parsed.subtasks) {
      const subtask = await createTask(supabase, {
        title: sub.title,
        prompt: sub.description || sub.title,
        description: sub.description,
        priority: sub.priority ?? task.priority,
        tools: sub.tools || task.tools,
        parent_task_id: task.id,
      });
      console.log(`[Executor] Created subtask: ${sub.title}`);

      // Push subtask to ClickUp for visibility
      if (subtask) {
        await pushNewTaskToClickUp(supabase, subtask).catch((err) =>
          console.error("[Executor] ClickUp push error:", err)
        );
      }
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error(`[Executor] Task failed: ${task.title}`, errorMsg);
    await failTask(supabase, task.id, errorMsg);
    await notifyUser(
      BOT_TOKEN,
      `**Task failed:** ${task.title}\n\nError: ${errorMsg}`
    );
  } finally {
    isExecuting = false;
  }
}

/**
 * Build the full prompt for a task execution.
 */
function buildTaskPrompt(
  task: Task,
  memoryContext: string,
  relevantContext: string
): string {
  const now = new Date();
  const timeStr = now.toLocaleString("en-US", {
    timeZone: USER_TIMEZONE,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  const parts = [
    "You are an autonomous AI agent executing a background task. Complete the task thoroughly and report your results.",
    "",
    `Task: ${task.title}`,
  ];

  if (task.description) {
    parts.push(`Description: ${task.description}`);
  }

  parts.push(`Priority: ${task.priority}`);

  if (USER_NAME) parts.push(`\nYou are working for ${USER_NAME}.`);
  parts.push(`Current time: ${timeStr}`);

  const profile = getProfileContext();
  if (profile) parts.push(`\nProfile:\n${profile}`);
  if (memoryContext) parts.push(`\n${memoryContext}`);
  if (relevantContext) parts.push(`\n${relevantContext}`);

  parts.push(
    "\nRESPONSE TAGS:" +
      "\nUse these tags in your response (they are processed automatically):" +
      "\n[NEEDS_APPROVAL: description of what needs approval]  — Pause and ask the human before proceeding" +
      "\n[SUBTASK: title | DESCRIPTION: details]  — Create a follow-up task" +
      "\n[REMEMBER: fact to store]  — Save to long-term memory" +
      "\n[GOAL: goal text | DEADLINE: optional date]  — Track a goal" +
      "\n[DONE: search text for completed goal]  — Mark a goal complete"
  );

  parts.push(`\nExecute this task now:\n${task.prompt}`);

  return parts.join("\n");
}

/**
 * Spawn Claude CLI for a task.
 */
async function callClaudeForTask(
  prompt: string,
  sessionId?: string | null
): Promise<string> {
  const args = [CLAUDE_PATH, "-p", prompt, "--output-format", "text"];

  if (sessionId) {
    args.push("--resume", sessionId);
  }

  console.log(`[Executor] Calling Claude: ${prompt.substring(0, 80)}...`);

  const proc = spawn(args, {
    stdout: "pipe",
    stderr: "pipe",
    cwd: PROJECT_DIR || undefined,
    env: {
      ...process.env,
      CLAUDECODE: undefined,
    },
  });

  const output = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    throw new Error(stderr || `Claude exited with code ${exitCode}`);
  }

  return output.trim();
}

/**
 * Parse Claude's response for task-specific intent tags.
 */
function parseTaskResult(response: string): ParsedTaskResult {
  let clean = response;
  const subtasks: ParsedTaskResult["subtasks"] = [];
  const scheduledPosts: ParsedTaskResult["scheduledPosts"] = [];
  let needsApproval = false;
  let approvalPrompt: string | undefined;

  // [NEEDS_APPROVAL: description]
  const approvalMatch = clean.match(/\[NEEDS_APPROVAL:\s*(.+?)\]/i);
  if (approvalMatch) {
    needsApproval = true;
    approvalPrompt = approvalMatch[1];
    clean = clean.replace(approvalMatch[0], "");
  }

  // [SUBTASK: title | DESCRIPTION: details]
  for (const match of response.matchAll(
    /\[SUBTASK:\s*(.+?)(?:\s*\|\s*DESCRIPTION:\s*(.+?))?\]/gi
  )) {
    subtasks.push({
      title: match[1].trim(),
      description: match[2]?.trim(),
    });
    clean = clean.replace(match[0], "");
  }

  // [SCHEDULE_POST: platform | content]
  for (const match of response.matchAll(
    /\[SCHEDULE_POST:\s*(.+?)\s*\|\s*(.+?)\]/gi
  )) {
    scheduledPosts.push({
      platform: match[1].trim(),
      content: match[2].trim(),
    });
    clean = clean.replace(match[0], "");
  }

  return {
    response: clean.trim(),
    needsApproval,
    approvalPrompt,
    subtasks,
    scheduledPosts,
  };
}
