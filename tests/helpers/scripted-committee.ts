import type { LlmChatOptions, LlmPort } from "../../src/application/ports.js";

export interface ScriptedProposal {
  title: string;
  rationale: string;
  confidence: number;
  targets: { ticker: string; weight: number }[];
  orders: { ticker: string; side: "BUY" | "SELL"; value: number; reason: string }[];
}

/**
 * A scripted committee agent for buildApp({ committeeLlms }) e2e tests:
 * a fixed proposal, a fixed feedback verdict, and a vote for `ids[0]` of the
 * OTHER agents' proposals (creation order). Prompt matching mirrors the real
 * CommitteeService prompts.
 */
export class ScriptedCommitteeLlm implements LlmPort {
  constructor(
    private readonly proposal: ScriptedProposal,
    private readonly feedbackVerdict: "positive" | "negative" = "positive",
    private readonly voteFn: (ids: string[]) => string = (ids) => ids[0]!,
  ) {}

  available(): boolean {
    return true;
  }

  async chat(_opts: LlmChatOptions): Promise<string> {
    return "";
  }

  async chatJson<T>(opts: LlmChatOptions): Promise<T> {
    const sys = opts.system;
    if (sys.includes("propose YOUR target asset allocation")) return this.proposal as unknown as T;
    if (sys.includes("Review it critically")) {
      return { verdict: this.feedbackVerdict, comment: "scripted review comment" } as unknown as T;
    }
    if (sys.includes("vote for exactly ONE proposal")) {
      const ids = [...sys.matchAll(/^- (\S+) — /gm)].map((m) => m[1]!);
      return { choice: this.voteFn(ids) } as unknown as T;
    }
    throw new Error(`unexpected prompt: ${sys.slice(0, 80)}`);
  }
}

/**
 * With 3 agents all voting ids[0], the FIRST agent wins round 1 with 2 votes
 * (a1→p2, a2→p1, a3→p1). Its proposal is the one that reaches the gate.
 */
export function firstAgentWins(winner: ScriptedProposal, others: ScriptedProposal[]): Map<string, LlmPort> {
  const llms = new Map<string, LlmPort>();
  llms.set("a1", new ScriptedCommitteeLlm(winner));
  others.forEach((p, i) => llms.set(`a${i + 2}`, new ScriptedCommitteeLlm(p)));
  return llms;
}
