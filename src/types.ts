/**
 * Shared TypeScript interfaces for the autonomous agent system.
 */

// ============================================================
// TASK SYSTEM
// ============================================================

export type TaskType = "one_shot" | "recurring" | "multi_step";

export type TaskStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "paused"
  | "awaiting_approval";

export interface Task {
  id: string;
  created_at: string;
  updated_at: string;
  type: TaskType;
  status: TaskStatus;
  title: string;
  description: string | null;
  prompt: string;
  tools: string[];
  priority: number;
  max_retries: number;
  retry_count: number;
  result: string | null;
  error: string | null;
  parent_task_id: string | null;
  depends_on: string[];
  scheduled_for: string | null;
  recurrence: string | null;
  session_id: string | null;
  metadata: Record<string, unknown>;
}

// ============================================================
// TOOL SYSTEM
// ============================================================

export interface Tool {
  name: string;
  description: string;
  category:
    | "github"
    | "browser"
    | "social"
    | "project_mgmt"
    | "communication"
    | "system";
  /** Instructions included in Claude's prompt when this tool is active */
  promptInstructions: string;
}

export interface ToolResult {
  success: boolean;
  output: string;
  artifacts?: string[];
}

// ============================================================
// EXECUTION
// ============================================================

export interface ExecutionContext {
  task: Task;
  tools: Tool[];
  memoryContext: string;
  profileContext: string;
  sessionId?: string;
}

export interface ParsedTaskResult {
  /** The main response text (with intent tags stripped) */
  response: string;
  /** Whether the task needs human approval before continuing */
  needsApproval: boolean;
  /** Approval details if needsApproval is true */
  approvalPrompt?: string;
  /** Subtasks to create */
  subtasks: Array<{
    title: string;
    description?: string;
    priority?: number;
    tools?: string[];
  }>;
  /** Scheduled posts to create */
  scheduledPosts: Array<{
    platform: string;
    content: string;
    scheduledFor?: string;
  }>;
}

// ============================================================
// SESSION
// ============================================================

export interface SessionState {
  sessionId: string | null;
  lastActivity: string;
}
