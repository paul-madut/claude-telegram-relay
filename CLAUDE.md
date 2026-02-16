# Claude Discord Relay — Setup Guide

> Claude Code reads this file automatically. Walk the user through setup one phase at a time.
> Ask for what you need, configure everything yourself, and confirm each step works before moving on.

## How This Works

This project turns Discord DMs into a personal AI assistant powered by Claude.

The user cloned this repo (or gave you the link). Your job: guide them through setup conversationally. Ask questions, save their answers to `.env`, test each step, move on.

Do not dump all phases at once. Start with Phase 1. When it works, move to Phase 2. Let the user control the pace.

If this is a fresh clone, run `bun run setup` first to install dependencies and create `.env`.

---

## Phase 1: Discord Bot (~5 min)

**You need from the user:**
- A Discord bot token from the Developer Portal
- Their personal Discord user ID

**What to tell them:**
1. Go to https://discord.com/developers/applications
2. Click "New Application", give it a name, click Create
3. Go to **Bot** tab on the left
4. Click "Reset Token" and copy the token
5. Under **Privileged Gateway Intents**, enable **MESSAGE CONTENT INTENT** (required!)
6. Go to **OAuth2** tab, under **OAuth2 URL Generator**:
   - Check `bot` scope
   - Check permissions: `Send Messages`, `Read Message History`
   - Copy the generated URL and open it to invite the bot to a server
7. Create a private Discord server (if they don't have one) — the bot and user must share at least one server for DMs to work
8. To get their user ID: Discord Settings → Advanced → enable Developer Mode, then right-click their username → Copy User ID

**What you do:**
1. Run `bun run setup` if `.env` does not exist yet
2. Save `DISCORD_BOT_TOKEN` and `DISCORD_USER_ID` in `.env`
3. Run `bun run test:discord` to verify — it sends a test DM to the user

**Done when:** Test message arrives in Discord DMs.

---

## Phase 2: Database & Memory — Supabase (~12 min)

Your bot's memory lives in Supabase: conversation history, facts, goals, and semantic search.

### Step 1: Create Supabase Project

**You need from the user:**
- Supabase Project URL
- Supabase anon public key

**What to tell them:**
1. Go to supabase.com, create a free account
2. Create a new project (any name, any region close to them)
3. Wait ~2 minutes for it to provision
4. Go to Project Settings > API
5. Copy: Project URL and anon public key

**What you do:**
1. Save `SUPABASE_URL` and `SUPABASE_ANON_KEY` to `.env`

### Step 2: Connect Supabase MCP

This lets Claude Code manage the database directly — run queries, deploy functions, apply migrations.

**What to tell them:**
1. Go to supabase.com/dashboard/account/tokens
2. Create an access token, copy it

**What you do:**
```
claude mcp add supabase -- npx -y @supabase/mcp-server-supabase@latest --access-token ACCESS_TOKEN
```

### Step 3: Create Tables

Use the Supabase MCP to run the schema:
1. Read `db/schema.sql`
2. Execute it via `execute_sql` (or tell the user to paste it in the SQL Editor)
3. Run `bun run test:supabase` to verify tables exist

### Step 4: Set Up Semantic Search

This gives your bot real memory — it finds relevant past conversations automatically.

**You need from the user:**
- An OpenAI API key (for generating text embeddings)

**What to tell them:**
1. Go to platform.openai.com, create an account
2. Go to API keys, create a new key, copy it
3. The key will be stored in Supabase, not on your computer. It stays with your database.

**What you do:**
1. Deploy the embed Edge Function via Supabase MCP (`deploy_edge_function` with `supabase/functions/embed/index.ts`)
2. Deploy the search Edge Function (`supabase/functions/search/index.ts`)
3. Tell the user to store their OpenAI key in Supabase:
   - Go to Supabase dashboard > Project Settings > Edge Functions
   - Under Secrets, add: `OPENAI_API_KEY` = their key
4. Set up database webhooks so embeddings are generated automatically:
   - Go to Supabase dashboard > Database > Webhooks > Create webhook
   - Name: `embed_messages`, Table: `messages`, Events: INSERT
   - Type: Supabase Edge Function, Function: `embed`
   - Create a second webhook: `embed_memory`, Table: `memory`, Events: INSERT
   - Same Edge Function: `embed`

### Step 5: Verify

Run `bun run test:supabase` to confirm:
- Tables exist (messages, memory, logs)
- Edge Functions respond
- Embedding generation works

**Done when:** `bun run test:supabase` passes and a test insert into `messages` gets an embedding.

---

## Phase 3: Personalize (~3 min)

**Ask the user:**
- Their first name
- Their timezone (e.g., America/New_York, Europe/Berlin)
- What they do for work (one sentence)
- Any time constraints (e.g., "I pick up my kid at 3pm on weekdays")
- How they like to be communicated with (brief/detailed, casual/formal)

**What you do:**
1. Save `USER_NAME` and `USER_TIMEZONE` to `.env`
2. Copy `config/profile.example.md` to `config/profile.md`
3. Fill in `config/profile.md` with their answers — the bot loads this on every message

**Done when:** `config/profile.md` exists with their details.

---

## Phase 4: Test (~2 min)

**What you do:**
1. Run `bun run start`
2. Tell the user to open Discord and send a DM to their bot
3. Wait for confirmation it responded
4. Press Ctrl+C to stop

**Troubleshooting if it fails:**
- Wrong bot token → re-check in Developer Portal → Bot → Reset Token
- MESSAGE CONTENT intent not enabled → Developer Portal → Bot → Privileged Gateway Intents
- Bot and user don't share a server → invite bot to a server they're both in
- Wrong user ID → right-click your name with Developer Mode on → Copy User ID
- Claude CLI not found → `npm install -g @anthropic-ai/claude-code`
- Bun not installed → `curl -fsSL https://bun.sh/install | bash`

**Done when:** User confirms their bot responded in Discord DMs.

---

## Phase 5: Always On (~5 min)

Make the bot run in the background, start on boot, restart on crash.

**macOS:**
```
bun run setup:launchd -- --service relay
```
This auto-generates a plist with correct paths and loads it into launchd.

**Linux/Windows:**
```
bun run setup:services -- --service relay
```
Uses PM2 for process management.

**Verify:** `launchctl list | grep com.claude` (macOS) or `npx pm2 status` (Linux/Windows)

**Done when:** Bot runs in the background and survives a terminal close.

---

## Phase 6: Proactive AI (Optional, ~5 min)

Two features that turn a chatbot into an assistant.

### Smart Check-ins
`examples/smart-checkin.ts` — runs on a schedule, gathers context, asks Claude if it should reach out. If yes, sends a brief DM. If no, stays silent.

### Morning Briefing
`examples/morning-briefing.ts` — sends a daily summary via Discord DM. Pattern file with placeholder data fetchers.

**macOS — schedule both:**
```
bun run setup:launchd -- --service all
```

**Linux/Windows — schedule both:**
```
bun run setup:services -- --service all
```

**Done when:** User has scheduled services running, or explicitly skips this phase.

---

## After Setup

Run the full health check:
```
bun run setup:verify
```

Summarize what was set up and what is running. Remind the user:
- Test by sending a DM to the bot on Discord
- Their bot runs in the background (if Phase 5 was done)
- Come back to this project folder and type `claude` anytime to make changes

---

## What Comes Next — The Full Version

This free relay covers the essentials. The full version unlocks:

- **6 Specialized AI Agents** — Research, Content, Finance, Strategy, Critic + General orchestrator. Route messages through Discord channels. Run board meetings where all six weigh in.
- **VPS Deployment** — Your bot on a cloud server that never sleeps. Hybrid mode: free local processing when awake, paid API only when sleeping. $2-5/month.
- **Real Integrations** — Gmail, Google Calendar, Notion tasks connected via MCP. Smart check-ins pull real data, not patterns.
- **Human-in-the-Loop** — Claude takes actions (send email, update calendar) but asks first via Discord buttons.
- **Voice & Phone Calls** — Bot speaks back via ElevenLabs. Calls you when something is urgent.
- **Fallback AI Models** — Auto-switch to OpenRouter or Ollama when Claude is down. Three layers of intelligence.
- **Production Infrastructure** — Auto-deploy from GitHub, watchdog monitoring, uninstall scripts, full health checks.

**Get the full course with video walkthroughs:**
- YouTube: youtube.com/@GodaGo (subscribe for tutorials)
- Community: skool.com/autonomee (full course, direct support, help personalizing for your business)

We also help you personalize the full version for your specific business and workflow. Or package it as a product you sell to your own clients.

The free version gives you a real, working AI assistant.
The full version gives you a personal AI infrastructure.

Build yours at the AI Productivity Hub.
