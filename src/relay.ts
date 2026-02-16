/**
 * Claude Code Discord Relay
 *
 * Minimal relay that connects Discord DMs to Claude Code CLI.
 * Customize this for your own needs.
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
import { join, dirname } from "path";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import {
  processMemoryIntents,
  getMemoryContext,
  getRelevantContext,
} from "./memory.ts";

const PROJECT_ROOT = dirname(dirname(import.meta.path));

// ============================================================
// CONFIGURATION
// ============================================================

const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || "";
const ALLOWED_USER_ID = process.env.DISCORD_USER_ID || "";
const CLAUDE_PATH = process.env.CLAUDE_PATH || "claude";
const PROJECT_DIR = process.env.PROJECT_DIR || "";
const RELAY_DIR = process.env.RELAY_DIR || join(process.env.HOME || "~", ".claude-relay");

// Directories
const TEMP_DIR = join(RELAY_DIR, "temp");
const UPLOADS_DIR = join(RELAY_DIR, "uploads");

// Session tracking for conversation continuity
const SESSION_FILE = join(RELAY_DIR, "session.json");

interface SessionState {
  sessionId: string | null;
  lastActivity: string;
}

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

const LOCK_FILE = join(RELAY_DIR, "bot.lock");

async function acquireLock(): Promise<boolean> {
  try {
    const existingLock = await readFile(LOCK_FILE, "utf-8").catch(() => null);

    if (existingLock) {
      const pid = parseInt(existingLock);
      try {
        process.kill(pid, 0); // Check if process exists
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

// Cleanup on exit
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

// Create directories
await mkdir(TEMP_DIR, { recursive: true });
await mkdir(UPLOADS_DIR, { recursive: true });

// ============================================================
// SUPABASE (optional — only if configured)
// ============================================================

const supabase: SupabaseClient | null =
  process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY
    ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)
    : null;

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
// CORE: Call Claude CLI
// ============================================================

async function callClaude(
  prompt: string,
  options?: { resume?: boolean; imagePath?: string }
): Promise<string> {
  const args = [CLAUDE_PATH, "-p", prompt];

  // Resume previous session if available and requested
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
      },
    });

    const output = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();

    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      console.error("Claude error:", stderr);
      return `Error: ${stderr || "Claude exited with code " + exitCode}`;
    }

    // Extract session ID from output if present (for --resume)
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
// MESSAGE HANDLERS
// ============================================================

async function handleText(message: Message, text: string): Promise<void> {
  console.log(`Message: ${text.substring(0, 50)}...`);

  // Start typing indicator (Discord typing expires after ~10s)
  const typingInterval = setInterval(() => {
    message.channel.sendTyping().catch(() => {});
  }, 8000);
  message.channel.sendTyping().catch(() => {});

  try {
    await saveMessage("user", text);

    // Gather context: semantic search + facts/goals
    const [relevantContext, memoryContext] = await Promise.all([
      getRelevantContext(supabase, text),
      getMemoryContext(supabase),
    ]);

    const enrichedPrompt = buildPrompt(text, relevantContext, memoryContext);
    const rawResponse = await callClaude(enrichedPrompt, { resume: true });

    // Parse and save any memory intents, strip tags from response
    const response = await processMemoryIntents(supabase, rawResponse);

    await saveMessage("assistant", response);
    await sendResponse(message, response);
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
    // Get the first image attachment
    const attachment = message.attachments.find((a) =>
      a.contentType?.startsWith("image/")
    );
    if (!attachment) return;

    // Download the image
    const timestamp = Date.now();
    const filePath = join(UPLOADS_DIR, `image_${timestamp}.jpg`);

    const response = await fetch(attachment.url);
    const buffer = await response.arrayBuffer();
    await writeFile(filePath, Buffer.from(buffer));

    // Claude Code can see images via file path
    const caption = message.content || "Analyze this image.";
    const prompt = `[Image: ${filePath}]\n\n${caption}`;

    await saveMessage("user", `[Image]: ${caption}`);

    const claudeResponse = await callClaude(prompt, { resume: true });

    // Cleanup after processing
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
  // Ignore bot messages
  if (message.author.bot) return;

  // DM only
  if (message.channel.type !== ChannelType.DM) return;

  // Security: only respond to authorized user
  if (ALLOWED_USER_ID && message.author.id !== ALLOWED_USER_ID) {
    console.log(`Unauthorized: ${message.author.id}`);
    await message.reply("This bot is private.");
    return;
  }

  // Check for attachments
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

// Load profile once at startup
let profileContext = "";
try {
  profileContext = await readFile(join(PROJECT_ROOT, "config", "profile.md"), "utf-8");
} catch {
  // No profile yet — that's fine
}

const USER_NAME = process.env.USER_NAME || "";
const USER_TIMEZONE = process.env.USER_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone;

function buildPrompt(
  userMessage: string,
  relevantContext?: string,
  memoryContext?: string
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
    "You are a personal AI assistant responding via Discord DM. Keep responses concise and conversational.",
  ];

  if (USER_NAME) parts.push(`You are speaking with ${USER_NAME}.`);
  parts.push(`Current time: ${timeStr}`);
  if (profileContext) parts.push(`\nProfile:\n${profileContext}`);
  if (memoryContext) parts.push(`\n${memoryContext}`);
  if (relevantContext) parts.push(`\n${relevantContext}`);

  parts.push(
    "\nMEMORY MANAGEMENT:" +
      "\nWhen the user shares something worth remembering, sets goals, or completes goals, " +
      "include these tags in your response (they are processed automatically and hidden from the user):" +
      "\n[REMEMBER: fact to store]" +
      "\n[GOAL: goal text | DEADLINE: optional date]" +
      "\n[DONE: search text for completed goal]"
  );

  parts.push(`\nUser: ${userMessage}`);

  return parts.join("\n");
}

async function sendResponse(message: Message, response: string): Promise<void> {
  // Discord has a 2000 character limit
  const MAX_LENGTH = 1950;

  if (response.length <= MAX_LENGTH) {
    await message.reply(response);
    return;
  }

  // Split long responses
  const chunks: string[] = [];
  let remaining = response;

  while (remaining.length > 0) {
    if (remaining.length <= MAX_LENGTH) {
      chunks.push(remaining);
      break;
    }

    // Try to split at a natural boundary
    let splitIndex = remaining.lastIndexOf("\n\n", MAX_LENGTH);
    if (splitIndex === -1) splitIndex = remaining.lastIndexOf("\n", MAX_LENGTH);
    if (splitIndex === -1) splitIndex = remaining.lastIndexOf(" ", MAX_LENGTH);
    if (splitIndex === -1) splitIndex = MAX_LENGTH;

    chunks.push(remaining.substring(0, splitIndex));
    remaining = remaining.substring(splitIndex).trim();
  }

  // First chunk as reply, rest as follow-up messages
  for (let i = 0; i < chunks.length; i++) {
    if (i === 0) {
      await message.reply(chunks[i]);
    } else {
      await message.channel.send(chunks[i]);
    }
  }
}

// ============================================================
// START
// ============================================================

console.log("Starting Claude Discord Relay...");
console.log(`Authorized user: ${ALLOWED_USER_ID || "ANY (not recommended)"}`);
console.log(`Project directory: ${PROJECT_DIR || "(relay working directory)"}`);

client.once("ready", () => {
  console.log(`Bot is running! Logged in as ${client.user?.tag}`);
});

client.login(BOT_TOKEN);
