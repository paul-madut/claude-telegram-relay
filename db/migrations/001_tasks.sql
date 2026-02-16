-- ============================================================
-- Migration 001: Tasks table for autonomous agent execution
-- ============================================================
-- Run this in your Supabase SQL Editor or via Supabase MCP.

CREATE TABLE IF NOT EXISTS tasks (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  -- Task definition
  type TEXT NOT NULL DEFAULT 'one_shot'
    CHECK (type IN ('one_shot', 'recurring', 'multi_step')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'completed', 'failed', 'paused', 'awaiting_approval')),
  title TEXT NOT NULL,
  description TEXT,
  prompt TEXT NOT NULL,

  -- Execution config
  tools TEXT[] DEFAULT '{}',
  priority INTEGER DEFAULT 0,
  max_retries INTEGER DEFAULT 3,
  retry_count INTEGER DEFAULT 0,

  -- Results
  result TEXT,
  error TEXT,

  -- Relationships
  parent_task_id UUID REFERENCES tasks(id),
  depends_on UUID[] DEFAULT '{}',

  -- Scheduling
  scheduled_for TIMESTAMPTZ,
  recurrence TEXT,           -- Cron expression for recurring tasks

  -- Claude session
  session_id TEXT,

  -- Flexible metadata
  metadata JSONB DEFAULT '{}'
);

-- Indexes for the execution loop
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_scheduled ON tasks(scheduled_for)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks(priority DESC, created_at ASC)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_task_id)
  WHERE parent_task_id IS NOT NULL;

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION update_tasks_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tasks_updated_at ON tasks;
CREATE TRIGGER tasks_updated_at
  BEFORE UPDATE ON tasks
  FOR EACH ROW
  EXECUTE FUNCTION update_tasks_updated_at();

-- RPC: Get next executable task (atomic claim)
CREATE OR REPLACE FUNCTION get_next_task()
RETURNS SETOF tasks AS $$
BEGIN
  RETURN QUERY
  WITH next AS (
    SELECT * FROM tasks
    WHERE status = 'pending'
      AND (scheduled_for IS NULL OR scheduled_for <= NOW())
      AND (
        depends_on IS NULL
        OR depends_on = '{}'
        OR NOT EXISTS (
          SELECT 1 FROM unnest(depends_on) AS dep_id
          WHERE EXISTS (
            SELECT 1 FROM tasks WHERE id = dep_id AND status != 'completed'
          )
        )
      )
    ORDER BY priority DESC, created_at ASC
    LIMIT 1
    FOR UPDATE SKIP LOCKED
  )
  UPDATE tasks
  SET status = 'running', updated_at = NOW()
  FROM next
  WHERE tasks.id = next.id
  RETURNING tasks.*;
END;
$$ LANGUAGE plpgsql;

-- RLS policies (match existing pattern from schema.sql)
ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all operations on tasks"
  ON tasks FOR ALL
  USING (true)
  WITH CHECK (true);
