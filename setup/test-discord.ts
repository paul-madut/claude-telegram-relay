/**
 * Claude Discord Relay — Test Discord Connection
 *
 * Verifies bot token and user ID are valid by sending a test DM.
 *
 * Usage: bun run setup/test-discord.ts
 */

import { join, dirname } from "path";

const PROJECT_ROOT = dirname(import.meta.dir);

// Colors
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

const PASS = green("✓");
const FAIL = red("✗");

const DISCORD_API = "https://discord.com/api/v10";

// Load .env manually (no dotenv dependency)
async function loadEnv(): Promise<Record<string, string>> {
  const envPath = join(PROJECT_ROOT, ".env");
  try {
    const content = await Bun.file(envPath).text();
    const vars: Record<string, string> = {};
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      vars[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
    }
    return vars;
  } catch {
    return {};
  }
}

async function main() {
  console.log("");
  console.log(bold("  Discord Connection Test"));
  console.log("");

  const env = await loadEnv();
  const token = env.DISCORD_BOT_TOKEN || process.env.DISCORD_BOT_TOKEN || "";
  const userId = env.DISCORD_USER_ID || process.env.DISCORD_USER_ID || "";

  // Check token exists
  if (!token || token === "your_bot_token_from_discord") {
    console.log(`  ${FAIL} DISCORD_BOT_TOKEN not set in .env`);
    console.log(`      ${dim("Get one from https://discord.com/developers/applications")}`);
    process.exit(1);
  }
  console.log(`  ${PASS} Bot token found`);

  // Check user ID exists
  if (!userId || userId === "your_discord_user_id") {
    console.log(`  ${FAIL} DISCORD_USER_ID not set in .env`);
    console.log(`      ${dim("Enable Developer Mode in Discord Settings > Advanced,")}`);
    console.log(`      ${dim("then right-click your name > Copy User ID")}`);
    process.exit(1);
  }
  console.log(`  ${PASS} User ID found: ${userId}`);

  // Test bot token with GET /users/@me
  console.log(`\n  Testing bot token...`);
  try {
    const meRes = await fetch(`${DISCORD_API}/users/@me`, {
      headers: { Authorization: `Bot ${token}` },
    });
    const meData = (await meRes.json()) as any;

    if (!meRes.ok) {
      console.log(`  ${FAIL} Invalid bot token`);
      console.log(`      ${dim(meData.message || "Check your token in the Developer Portal")}`);
      process.exit(1);
    }

    console.log(`  ${PASS} Bot: ${meData.username}#${meData.discriminator} (${meData.id})`);
  } catch (err: any) {
    console.log(`  ${FAIL} Could not reach Discord API`);
    console.log(`      ${dim(err.message)}`);
    process.exit(1);
  }

  // Send test DM
  console.log(`\n  Sending test DM...`);
  try {
    // Step 1: Create DM channel
    const dmRes = await fetch(`${DISCORD_API}/users/@me/channels`, {
      method: "POST",
      headers: {
        Authorization: `Bot ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ recipient_id: userId }),
    });
    const dmData = (await dmRes.json()) as any;

    if (!dmRes.ok) {
      if (dmData.code === 50007) {
        console.log(`  ${FAIL} Cannot send DM to user ${userId}`);
        console.log(`      ${dim("The bot and user must share at least one server.")}`);
        console.log(`      ${dim("Create a private server and invite the bot to it.")}`);
      } else {
        console.log(`  ${FAIL} Could not create DM channel: ${dmData.message}`);
      }
      process.exit(1);
    }

    const channelId = dmData.id;

    // Step 2: Send message
    const msgRes = await fetch(`${DISCORD_API}/channels/${channelId}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bot ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        content: "Connection test successful! Your bot is working.",
      }),
    });
    const msgData = (await msgRes.json()) as any;

    if (!msgRes.ok) {
      console.log(`  ${FAIL} Send failed: ${msgData.message}`);
      process.exit(1);
    }

    console.log(`  ${PASS} Test message sent! Check your Discord DMs.`);
  } catch (err: any) {
    console.log(`  ${FAIL} Could not send message`);
    console.log(`      ${dim(err.message)}`);
    process.exit(1);
  }

  console.log(`\n  ${green("All good!")} Your Discord bot is configured correctly.`);
  console.log("");
}

main().catch((err) => {
  console.error(`\n  ${red("Error:")} ${err.message}`);
  process.exit(1);
});
