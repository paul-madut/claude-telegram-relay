/**
 * Claude Code Discord Relay — Autonomous Agent
 *
 * Connects Discord DMs to Claude Code CLI with:
 * - Real-time message handling (text, images, documents)
 * - Background task queue and autonomous execution
 * - Persistent memory (Supabase)
 *
 * Run: bun run src/relay.ts
 */

import {
  Client,
  GatewayIntentBits,
  Partials,
  Message,
  ChannelType,
} from "discord.js";
import { spawn } from "bun";
import { writeFile, mkdir, readFile, unlink } from "fs/promises";
import { join } from "path";
import {
  processMemoryIntents,
  getMemoryContext,
  getRelevantContext,
} from "./memory.ts";
import { sendResponse } from "./discord-helpers.ts";
import { executionTick } from "./executor.ts";
import { createTask } from "./tasks.ts";
import { startClickUpSync, pushNewTaskToClickUp } from "./sync/clickup-sync.ts";
import { processClickUpIntents, getClickUpContext } from "./clickup-intents.ts";
import type { SessionState } from "./types.ts";
import {
  BOT_TOKEN,
  ALLOWED_USER_ID,
  CLAUDE_PATH,
  PROJECT_DIR,
  RELAY_DIR,
  TEMP_DIR,
  UPLOADS_DIR,
  SESSION_FILE,
  LOCK_FILE,
  USER_NAME,
  USER_TIMEZONE,
  supabase,
  loadProfile,
  getProfileContext,
} from "./config.ts";

// ============================================================
// SESSION MANAGEMENT
// ============================================================

async function loadSession(): Promise<SessionState> {
  try {
    const content = await readFile(SESSION_FILE, "utf-8");
    return JSON.parse(content);
  } catch {
    return { sessionId: null, lastActivity: new Date().toISOString() };
  }
}

async function saveSession(state: SessionState): Promise<void> {
  await writeFile(SESSION_FILE, JSON.stringify(state, null, 2));
}

let session = await loadSession();

// ============================================================
// LOCK FILE (prevent multiple instances)
// ============================================================

async function acquireLock(): Promise<boolean> {
  try {
    const existingLock = await readFile(LOCK_FILE, "utf-8").catch(() => null);

    if (existingLock) {
      const pid = parseInt(existingLock);
      try {
        process.kill(pid, 0);
        console.log(`Another instance running (PID: ${pid})`);
        return false;
      } catch {
        console.log("Stale lock found, taking over...");
      }
    }

    await writeFile(LOCK_FILE, process.pid.toString());
    return true;
  } catch (error) {
    console.error("Lock error:", error);
    return false;
  }
}

async function releaseLock(): Promise<void> {
  await unlink(LOCK_FILE).catch(() => {});
}

process.on("exit", () => {
  try {
    require("fs").unlinkSync(LOCK_FILE);
  } catch {}
});
process.on("SIGINT", async () => {
  await releaseLock();
  process.exit(0);
});
process.on("SIGTERM", async () => {
  await releaseLock();
  process.exit(0);
});

// ============================================================
// SETUP
// ============================================================

if (!BOT_TOKEN) {
  console.error("DISCORD_BOT_TOKEN not set!");
  console.log("\nTo set up:");
  console.log("1. Go to https://discord.com/developers/applications");
  console.log("2. Create a New Application, then go to Bot → Reset Token");
  console.log("3. Enable MESSAGE CONTENT intent under Privileged Gateway Intents");
  console.log("4. Copy the token to .env");
  process.exit(1);
}

await mkdir(TEMP_DIR, { recursive: true });
await mkdir(UPLOADS_DIR, { recursive: true });
await loadProfile();

async function saveMessage(
  role: string,
  content: string,
  metadata?: Record<string, unknown>
): Promise<void> {
  if (!supabase) return;
  try {
    await supabase.from("messages").insert({
      role,
      content,
      channel: "discord",
      metadata: metadata || {},
    });
  } catch (error) {
    console.error("Supabase save error:", error);
  }
}

// Acquire lock
if (!(await acquireLock())) {
  console.error("Could not acquire lock. Another instance may be running.");
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.Guilds,
  ],
  partials: [Partials.Channel, Partials.Message],
});

// ============================================================
// CORE: Call Claude CLI (for direct DM responses)
// ============================================================

async function callClaude(
  prompt: string,
  options?: { resume?: boolean; imagePath?: string }
): Promise<string> {
  const args = [CLAUDE_PATH, "-p", prompt];

  if (options?.resume && session.sessionId) {
    args.push("--resume", session.sessionId);
  }

  args.push("--output-format", "text");

  console.log(`Calling Claude: ${prompt.substring(0, 50)}...`);

  try {
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
      console.error("Claude error:", stderr);
      return `Error: ${stderr || "Claude exited with code " + exitCode}`;
    }

    const sessionMatch = output.match(/Session ID: ([a-f0-9-]+)/i);
    if (sessionMatch) {
      session.sessionId = sessionMatch[1];
      session.lastActivity = new Date().toISOString();
      await saveSession(session);
    }

    return output.trim();
  } catch (error) {
    console.error("Spawn error:", error);
    return `Error: Could not run Claude CLI`;
  }
}

// ============================================================
// TASK DETECTION
// ============================================================

/**
 * Detect if a message is a task assignment vs a conversational message.
 * Returns the task description if it's a task, null otherwise.
 */
function detectTask(text: string): { title: string; description: string } | null {
  // Explicit "task:" prefix
  const taskPrefix = text.match(/^task:\s*(.+)/i);
  if (taskPrefix) {
    const desc = taskPrefix[1].trim();
    return { title: desc.substring(0, 100), description: desc };
  }

  // Explicit "do:" prefix
  const doPrefix = text.match(/^do:\s*(.+)/i);
  if (doPrefix) {
    const desc = doPrefix[1].trim();
    return { title: desc.substring(0, 100), description: desc };
  }

  // Explicit "background:" prefix
  const bgPrefix = text.match(/^background:\s*(.+)/i);
  if (bgPrefix) {
    const desc = bgPrefix[1].trim();
    return { title: desc.substring(0, 100), description: desc };
  }

  return null;
}

// ============================================================
// MESSAGE HANDLERS
// ============================================================

async function handleText(message: Message, text: string): Promise<void> {
  console.log(`Message: ${text.substring(0, 50)}...`);

  // Check if this is a task assignment
  const taskInfo = detectTask(text);
  if (taskInfo && supabase) {
    const task = await createTask(supabase, {
      title: taskInfo.title,
      prompt: taskInfo.description,
      description: taskInfo.description,
      metadata: { source: "discord", bot_executable: true },
    });

    if (task) {
      // Push to ClickUp for visibility
      await pushNewTaskToClickUp(supabase, task).catch((err) =>
        console.error("ClickUp push error:", err)
      );

      await message.reply(
        `**Task queued:** ${taskInfo.title}\nID: \`${task.id}\`\nThe agent will work on this in the background.`
      );
      await saveMessage("user", `[Task created]: ${text}`);
    } else {
      await message.reply("Could not create task. Is Supabase configured?");
    }
    return;
  }

  // Regular conversational message
  const typingInterval = setInterval(() => {
    message.channel.sendTyping().catch(() => {});
  }, 8000);
  message.channel.sendTyping().catch(() => {});

  try {
    await saveMessage("user", text);

    const [relevantContext, memoryContext] = await Promise.all([
      getRelevantContext(supabase, text),
      getMemoryContext(supabase),
    ]);

    const clickUpContext = await getClickUpContext();
    const enrichedPrompt = buildPrompt(text, relevantContext, memoryContext, clickUpContext);
    const rawResponse = await callClaude(enrichedPrompt, { resume: true });

    // Process intent tags (memory + ClickUp actions)
    const afterMemory = await processMemoryIntents(supabase, rawResponse);
    const { clean: response, results: clickUpResults } =
      await processClickUpIntents(afterMemory);

    // Append ClickUp action results if any
    let finalResponse = response;
    if (clickUpResults.length) {
      const summary = clickUpResults
        .map((r) => `${r.success ? "done" : "failed"}: ${r.task} — ${r.detail}`)
        .join("\n");
      finalResponse += `\n\n**ClickUp actions:**\n${summary}`;
    }

    await saveMessage("assistant", finalResponse);
    await sendResponse(message, finalResponse);
  } finally {
    clearInterval(typingInterval);
  }
}

async function handleImage(message: Message): Promise<void> {
  console.log("Image received");

  const typingInterval = setInterval(() => {
    message.channel.sendTyping().catch(() => {});
  }, 8000);
  message.channel.sendTyping().catch(() => {});

  try {
    const attachment = message.attachments.find((a) =>
      a.contentType?.startsWith("image/")
    );
    if (!attachment) return;

    const timestamp = Date.now();
    const filePath = join(UPLOADS_DIR, `image_${timestamp}.jpg`);

    const response = await fetch(attachment.url);
    const buffer = await response.arrayBuffer();
    await writeFile(filePath, Buffer.from(buffer));

    const caption = message.content || "Analyze this image.";
    const prompt = `[Image: ${filePath}]\n\n${caption}`;

    await saveMessage("user", `[Image]: ${caption}`);

    const claudeResponse = await callClaude(prompt, { resume: true });

    await unlink(filePath).catch(() => {});

    const cleanResponse = await processMemoryIntents(supabase, claudeResponse);
    await saveMessage("assistant", cleanResponse);
    await sendResponse(message, cleanResponse);
  } catch (error) {
    console.error("Image error:", error);
    await message.reply("Could not process image.");
  } finally {
    clearInterval(typingInterval);
  }
}

async function handleDocument(message: Message): Promise<void> {
  const attachment = message.attachments.find(
    (a) => !a.contentType?.startsWith("image/")
  );
  if (!attachment) return;

  console.log(`Document: ${attachment.name}`);

  const typingInterval = setInterval(() => {
    message.channel.sendTyping().catch(() => {});
  }, 8000);
  message.channel.sendTyping().catch(() => {});

  try {
    const timestamp = Date.now();
    const fileName = attachment.name || `file_${timestamp}`;
    const filePath = join(UPLOADS_DIR, `${timestamp}_${fileName}`);

    const response = await fetch(attachment.url);
    const buffer = await response.arrayBuffer();
    await writeFile(filePath, Buffer.from(buffer));

    const caption = message.content || `Analyze: ${attachment.name}`;
    const prompt = `[File: ${filePath}]\n\n${caption}`;

    await saveMessage("user", `[Document: ${attachment.name}]: ${caption}`);

    const claudeResponse = await callClaude(prompt, { resume: true });

    await unlink(filePath).catch(() => {});

    const cleanResponse = await processMemoryIntents(supabase, claudeResponse);
    await saveMessage("assistant", cleanResponse);
    await sendResponse(message, cleanResponse);
  } catch (error) {
    console.error("Document error:", error);
    await message.reply("Could not process document.");
  } finally {
    clearInterval(typingInterval);
  }
}

// ============================================================
// DISCORD EVENT: messageCreate
// ============================================================

client.on("messageCreate", async (message: Message) => {
  if (message.author.bot) return;
  if (message.channel.type !== ChannelType.DM) return;

  if (ALLOWED_USER_ID && message.author.id !== ALLOWED_USER_ID) {
    console.log(`Unauthorized: ${message.author.id}`);
    await message.reply("This bot is private.");
    return;
  }

  const hasImage = message.attachments.some((a) =>
    a.contentType?.startsWith("image/")
  );
  const hasDocument = message.attachments.some(
    (a) => a.contentType && !a.contentType.startsWith("image/")
  );

  if (hasImage) {
    await handleImage(message);
  } else if (hasDocument) {
    await handleDocument(message);
  } else if (message.content) {
    await handleText(message, message.content);
  }
});

// ============================================================
// HELPERS
// ============================================================

function buildPrompt(
  userMessage: string,
  relevantContext?: string,
  memoryContext?: string,
  clickUpContext?: string
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

  const profileContext = getProfileContext();

  const parts = [
    "You are a personal AI assistant responding via Discord DM. Keep responses concise and conversational.",
  ];

  if (USER_NAME) parts.push(`You are speaking with ${USER_NAME}.`);
  parts.push(`Current time: ${timeStr}`);
  if (profileContext) parts.push(`\nProfile:\n${profileContext}`);
  if (memoryContext) parts.push(`\n${memoryContext}`);
  if (relevantContext) parts.push(`\n${relevantContext}`);
  if (clickUpContext) parts.push(`\n${clickUpContext}`);

  parts.push(
    "\nMEMORY MANAGEMENT:" +
      "\nWhen the user shares something worth remembering, sets goals, or completes goals, " +
      "include these tags in your response (they are processed automatically and hidden from the user):" +
      "\n[REMEMBER: fact to store]" +
      "\n[GOAL: goal text | DEADLINE: optional date]" +
      "\n[DONE: search text for completed goal]"
  );

  parts.push(
    "\nCLICKUP TASK MANAGEMENT:" +
      "\nYou have direct access to the user's ClickUp tasks (listed above under CLICKUP TASKS if any exist)." +
      "\nWhen the user asks you to manage ClickUp tasks, use these tags (executed automatically and hidden from user):" +
      '\n[CLICKUP_COMPLETE: task name] — Set task status to "ready for review"' +
      "\n[CLICKUP_CREATE: task name | DESCRIPTION: details | PRIORITY: 1-4 | TAGS: tag1,tag2] — Create a new task (PRIORITY/DESCRIPTION/TAGS optional)" +
      "\n[CLICKUP_UPDATE: task name | STATUS: new status] — Change a task's status" +
      "\n[CLICKUP_COMMENT: task name | COMMENT: text] — Add a comment to a task" +
      "\nMatch task names loosely — partial matches work. Use the exact task names from the CLICKUP TASKS list when available." +
      "\nExecute these actions directly. Do NOT ask for approval or mention scripts — just do it and confirm."
  );

  parts.push(`\nUser: ${userMessage}`);

  return parts.join("\n");
}

// ============================================================
// AUTONOMOUS EXECUTION LOOP
// ============================================================

const EXECUTION_INTERVAL = 30_000; // 30 seconds

function startExecutionLoop(): void {
  if (!supabase) {
    console.log("[Executor] Supabase not configured — task queue disabled");
    return;
  }

  console.log(
    `[Executor] Task queue active (checking every ${EXECUTION_INTERVAL / 1000}s)`
  );

  setInterval(async () => {
    try {
      await executionTick();
    } catch (error) {
      console.error("[Executor] Tick error:", error);
    }
  }, EXECUTION_INTERVAL);

  // Start ClickUp bidirectional sync
  startClickUpSync(supabase);
}

// ============================================================
// START
// ============================================================

console.log("Starting Claude Discord Relay...");
console.log(`Authorized user: ${ALLOWED_USER_ID || "ANY (not recommended)"}`);
console.log(`Project directory: ${PROJECT_DIR || "(relay working directory)"}`);

client.once("clientReady", () => {
  console.log(`Bot is running! Logged in as ${client.user?.tag}`);
  startExecutionLoop();
});

client.login(BOT_TOKEN);
