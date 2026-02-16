# Claude Discord Relay

A personal AI assistant on Discord (DM-only) powered by Claude Code.

You message it. Claude responds. Text, photos, documents. It remembers across sessions, checks in proactively, and runs in the background.

**Created by [Goda Go](https://youtube.com/@GodaGo)** | [AI Productivity Hub Community](https://skool.com/autonomee)

```
You ──▶ Discord DM ──▶ Relay ──▶ Claude Code CLI ──▶ Response
                                      │
                                Supabase (memory)
```

## What You Get

- **Relay**: Send DMs on Discord, get Claude responses back
- **Memory**: Semantic search over conversation history, persistent facts and goals via Supabase
- **Proactive**: Smart check-ins that know when to reach out (and when not to)
- **Briefings**: Daily morning summary with goals and schedule
- **Always On**: Runs in the background, starts on boot, restarts on crash
- **Guided Setup**: Claude Code reads CLAUDE.md and walks you through everything

## Quick Start

### Prerequisites

- **[Bun](https://bun.sh)** runtime (`curl -fsSL https://bun.sh/install | bash`)
- **[Claude Code](https://claude.ai/claude-code)** CLI installed and authenticated
- A **Discord** account

### Option A: Guided Setup (Recommended)

```bash
git clone https://github.com/godagoo/claude-telegram-relay.git
cd claude-telegram-relay
claude
```

Claude Code reads `CLAUDE.md` and walks you through setup conversationally:

1. Create a Discord bot via Developer Portal
2. Enable MESSAGE CONTENT privileged intent
3. Invite bot to a shared server
4. Set up Supabase for persistent memory
5. Personalize your profile
6. Test the bot
7. Configure always-on services
8. Set up proactive check-ins and briefings

### Option B: Manual Setup

```bash
git clone https://github.com/godagoo/claude-telegram-relay.git
cd claude-telegram-relay
bun run setup          # Install deps, create .env
# Edit .env with your API keys
bun run test:discord   # Verify bot token
bun run test:supabase  # Verify database
bun run start          # Start the bot
```

## Discord Bot Setup

1. Go to https://discord.com/developers/applications
2. Click **New Application** → name it → Create
3. Go to **Bot** tab:
   - Click **Reset Token**, copy it → `DISCORD_BOT_TOKEN` in `.env`
   - Enable **MESSAGE CONTENT INTENT** under Privileged Gateway Intents
4. Go to **OAuth2** → **URL Generator**:
   - Check `bot` scope
   - Check permissions: `Send Messages`, `Read Message History`
   - Open the generated URL to invite the bot to your server
5. Get your user ID: Discord Settings → Advanced → Developer Mode → right-click your name → Copy User ID → `DISCORD_USER_ID` in `.env`

**Important:** The bot and user must share at least one server for DMs to work. Create a private server if needed.

## Commands

```bash
# Run
bun run start              # Start the bot
bun run dev                # Start with auto-reload

# Setup & Testing
bun run setup              # Install dependencies, create .env
bun run test:discord       # Test Discord connection
bun run test:supabase      # Test Supabase connection
bun run setup:verify       # Full health check

# Always-On Services
bun run setup:launchd      # Configure launchd (macOS)
bun run setup:services     # Configure PM2 (Windows/Linux)

# Use --service flag for specific services:
# bun run setup:launchd -- --service relay
# bun run setup:launchd -- --service all    (relay + checkin + briefing)
```

## Project Structure

```
CLAUDE.md                    # Guided setup (Claude Code reads this)
src/
  relay.ts                   # Core relay daemon
  transcribe.ts              # Voice transcription (for future use)
  memory.ts                  # Persistent memory (facts, goals, semantic search)
examples/
  smart-checkin.ts           # Proactive check-ins
  morning-briefing.ts        # Daily briefing
  memory.ts                  # Memory persistence patterns
config/
  profile.example.md         # Personalization template
db/
  schema.sql                 # Supabase database schema
supabase/
  functions/
    embed/index.ts           # Auto-embedding Edge Function
    search/index.ts          # Semantic search Edge Function
setup/
  install.ts                 # Prerequisites checker
  test-discord.ts            # Discord connectivity test
  test-supabase.ts           # Supabase connectivity test
  configure-launchd.ts       # macOS service setup
  configure-services.ts      # Windows/Linux service setup
  verify.ts                  # Full health check
daemon/
  launchagent.plist          # macOS daemon template
  claude-relay.service       # Linux systemd template
  README-WINDOWS.md          # Windows options
```

## How It Works

The relay does three things:
1. **Listen** for Discord DMs (via discord.js)
2. **Spawn** Claude Code CLI with context (your profile, memory, time)
3. **Send** the response back as a Discord DM

Claude Code gives you full power: tools, MCP servers, web search, file access. Not just a model — an AI with hands.

Your bot remembers between sessions via Supabase. Every message gets an embedding (via OpenAI, stored in Supabase) so the bot can semantically search past conversations for relevant context. It also tracks facts and goals — Claude detects when you mention something worth remembering and stores it automatically.

## Environment Variables

See `.env.example` for all options. The essentials:

```bash
# Required
DISCORD_BOT_TOKEN=     # From Discord Developer Portal
DISCORD_USER_ID=       # Right-click → Copy User ID (Developer Mode)
SUPABASE_URL=          # From Supabase dashboard
SUPABASE_ANON_KEY=     # From Supabase dashboard

# Recommended
USER_NAME=             # Your first name
USER_TIMEZONE=         # e.g., America/New_York

# Note: OpenAI key for embeddings is stored in Supabase
# (Edge Function secrets), not in this .env file.
```

## What's Next

This relay is step one. It works standalone, forever. But it's also the foundation for something much bigger.

200+ builders are running the full version right now — their AI calls them when something is urgent, runs board meetings with six specialized agents, sends emails with approval buttons, and never goes offline.

The key: it's not just about features. It's about **mastering Claude Code** — CLAUDE.md files, MCP servers, hooks, skills. That's what turns a chatbot into real AI infrastructure. The community and course teach you that.

**[Read the full story → WHATS-NEXT.md](WHATS-NEXT.md)**

**Free course (6 lessons):** [autonomee.ai/telegram-bot-course](https://autonomee.ai/telegram-bot-course)
**Subscribe on YouTube:** [youtube.com/@GodaGo](https://youtube.com/@GodaGo)
**Join the community:** [skool.com/autonomee](https://skool.com/autonomee)

## License

MIT — Take it, customize it, make it yours.

---

Built by [Goda Go](https://youtube.com/@GodaGo)
