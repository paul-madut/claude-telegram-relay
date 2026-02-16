/**
 * Shared configuration module.
 * Centralizes env vars and paths used across the relay, executor, and tasks.
 */

import { join, dirname } from "path";
import { readFile } from "fs/promises";
import { createClient, SupabaseClient } from "@supabase/supabase-js";

export const PROJECT_ROOT = dirname(dirname(import.meta.path));

// ============================================================
// ENVIRONMENT
// ============================================================

export const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || "";
export const ALLOWED_USER_ID = process.env.DISCORD_USER_ID || "";
export const CLAUDE_PATH = process.env.CLAUDE_PATH || "claude";
export const PROJECT_DIR = process.env.PROJECT_DIR || "";
export const RELAY_DIR =
  process.env.RELAY_DIR || join(process.env.HOME || "~", ".claude-relay");

export const USER_NAME = process.env.USER_NAME || "";
export const USER_TIMEZONE =
  process.env.USER_TIMEZONE ||
  Intl.DateTimeFormat().resolvedOptions().timeZone;

// ============================================================
// DIRECTORIES
// ============================================================

export const TEMP_DIR = join(RELAY_DIR, "temp");
export const UPLOADS_DIR = join(RELAY_DIR, "uploads");
export const SESSION_FILE = join(RELAY_DIR, "session.json");
export const LOCK_FILE = join(RELAY_DIR, "bot.lock");

// ============================================================
// SUPABASE
// ============================================================

export const supabase: SupabaseClient | null =
  process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY
    ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)
    : null;

// ============================================================
// PROFILE
// ============================================================

let _profileContext = "";

export async function loadProfile(): Promise<string> {
  if (_profileContext) return _profileContext;
  try {
    _profileContext = await readFile(
      join(PROJECT_ROOT, "config", "profile.md"),
      "utf-8"
    );
  } catch {
    // No profile yet — that's fine
  }
  return _profileContext;
}

export function getProfileContext(): string {
  return _profileContext;
}
