/**
 * Discord helper functions.
 * Extracted from relay.ts for use by both the relay and executor.
 */

import { Message, Client, ChannelType } from "discord.js";
import { ALLOWED_USER_ID } from "./config.ts";

const DISCORD_API = "https://discord.com/api/v10";

/**
 * Send a (potentially long) response to a Discord message.
 * Splits at 1950 chars to stay under Discord's 2000 limit.
 */
export async function sendResponse(
  message: Message,
  response: string
): Promise<void> {
  const MAX_LENGTH = 1950;

  if (response.length <= MAX_LENGTH) {
    await message.reply(response);
    return;
  }

  const chunks = splitMessage(response, MAX_LENGTH);

  for (let i = 0; i < chunks.length; i++) {
    if (i === 0) {
      await message.reply(chunks[i]);
    } else {
      await message.channel.send(chunks[i]);
    }
  }
}

/**
 * Send a DM to the authorized user via REST API.
 * Used by the executor and proactive features (no Message object needed).
 */
export async function sendDM(
  botToken: string,
  userId: string,
  content: string
): Promise<boolean> {
  try {
    // Create/get DM channel
    const dmRes = await fetch(`${DISCORD_API}/users/@me/channels`, {
      method: "POST",
      headers: {
        Authorization: `Bot ${botToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ recipient_id: userId }),
    });
    if (!dmRes.ok) return false;
    const dmData = (await dmRes.json()) as any;

    // Split long messages
    const chunks = splitMessage(content, 1950);

    for (const chunk of chunks) {
      const msgRes = await fetch(
        `${DISCORD_API}/channels/${dmData.id}/messages`,
        {
          method: "POST",
          headers: {
            Authorization: `Bot ${botToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ content: chunk }),
        }
      );
      if (!msgRes.ok) return false;
    }

    return true;
  } catch {
    return false;
  }
}

/**
 * Notify the authorized user about a task event.
 */
export async function notifyUser(
  botToken: string,
  message: string
): Promise<void> {
  if (!ALLOWED_USER_ID) return;
  await sendDM(botToken, ALLOWED_USER_ID, message);
}

/**
 * Split a string into chunks at natural boundaries.
 */
function splitMessage(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    let splitIndex = remaining.lastIndexOf("\n\n", maxLength);
    if (splitIndex === -1) splitIndex = remaining.lastIndexOf("\n", maxLength);
    if (splitIndex === -1) splitIndex = remaining.lastIndexOf(" ", maxLength);
    if (splitIndex === -1) splitIndex = maxLength;

    chunks.push(remaining.substring(0, splitIndex));
    remaining = remaining.substring(splitIndex).trim();
  }

  return chunks;
}
