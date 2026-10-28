export type StepStatus = 'pending' | 'running' | 'done' | 'skipped'

/** One step of the plan; a micro-step has the id of the top-level step it belongs to as `parent`. */
export type Step = {
  id: string
  text: string
  status: StepStatus
  parent?: string
  /** Added by the person, not by Claude. */
  byUser?: boolean
  /** Renamed by the person after Claude wrote it. */
  editedByUser?: boolean
  /** Top-level steps that share a group run in parallel: "2a" and "2b" both have group "2". */
  group?: string
  startedAt?: number
  endedAt?: number
}

export type Plan = { title: string; steps: Step[]; startedAt: number }

export type RunStatus = 'running' | 'done' | 'failed'

export type AgentRun = {
  id: string
  type: string
  description: string
  model?: string
  parentId?: string
  background: boolean
  status: RunStatus
  startedAt: number
  endedAt?: number
  tokens: number
  tools: number
  lastTool?: string
}

export type BgTask = {
  id: string
  kind: 'shell' | 'monitor' | 'workflow'
  label: string
  status: RunStatus
  startedAt: number
  endedAt?: number
}

/** This session's running totals, the row the ledger keeps for it. */
export type SessionStats = {
  key: string
  started: number
  project: string
  title: string
  model: string
  cost: number
  lastCost: number
  tokens: number
  agentMs: number
  turns: number
}

declare module 'claude-code' {
  interface PluginState {
    omniboard: {
      plan: Plan | null
      /** Edits the person made that Claude has not read yet. */
      notes: string[]
      agents: AgentRun[]
      tasks: BgTask[]
      session: SessionStats | null
      /** The board's address while its server runs. */
      board: string | null
      /** The last edit the plan refused, shown in the board. */
      refused: string | null
      /** The prompt box holds a slash command: the band steps aside for the command list. */
      composing: boolean
      /** The user closed the band above the prompt: it stays closed until the next plan is set, or `/board band`. */
      bandHidden: boolean
    }
  }
}
