/**
 * The work order (rfcclub/anima#238, cartridge-worker-dispatch): what the host gives a task worker for one
 * session, built apart from executing it. Cartridge requirements are requests checked against what the adapter
 * can do; they never widen the grant. The order carries no identity, recall or memory: a task worker is not an
 * embodiment of any agent.
 */

export type WorkerNetwork = "none" | "gateway" | "internet";

/** What a cartridge asks for. A request, never authority. */
export interface WorkerRequirements {
  tools?: string[];
  network?: WorkerNetwork;
  skills?: string[];
  /** Writable scopes beyond the default grant, by name ("tree", "tmp", "home") or path. */
  writable?: string[];
}

/** What an adapter can provide; declared by the adapter itself. */
export interface AdapterCapabilities {
  adapter: string;
  tools: string[];
  network: WorkerNetwork[];
  /** Whether the adapter can run a cartridge's project skills. */
  skills: boolean;
  writable: string[];
}

export interface WorkCartridge {
  name: string;
  /** Prompt modules, in order. */
  modules: string[];
  /** Skills the cartridge grants. */
  skills: string[];
  requires?: WorkerRequirements;
}

export type RequirementCheck = { ok: true } | { ok: false; unsupported: string };

/** The first requirement the adapter cannot meet, checked in a fixed order: tools, network, skills, writable. */
export function checkRequirements(req: WorkerRequirements | undefined, caps: AdapterCapabilities): RequirementCheck {
  if (!req) return { ok: true };
  for (const tool of req.tools ?? []) if (!caps.tools.includes(tool)) return { ok: false, unsupported: `tool:${tool}` };
  if (req.network && !caps.network.includes(req.network)) return { ok: false, unsupported: `network:${req.network}` };
  if ((req.skills ?? []).length > 0 && !caps.skills) return { ok: false, unsupported: `skills:${req.skills!.join(",")}` };
  for (const scope of req.writable ?? []) if (!caps.writable.includes(scope)) return { ok: false, unsupported: `writable:${scope}` };
  return { ok: true };
}

export const HANDOFF_MAX_CHARS = 16_384;

export interface WorkOrderInput {
  work: { workId: string; repo: string; issue: number; branch: string };
  issue: { title: string; body: string };
  kind: "start-work" | "revise";
  feedback?: string;
  tree: string;
  budget: { maxIterations: number; deadlineMs: number };
  adapter: AdapterCapabilities;
  cartridge?: WorkCartridge;
  /** A note the previous worker left; `covered` is true only when a trusted checkpoint covers it. */
  handoff?: { text: string; covered: boolean };
}

export interface WorkOrder {
  task: { repo: string; issue: number; branch: string; title: string; body: string; kind: "start-work" | "revise"; feedback?: string };
  cartridge?: { name: string; modules: string[]; skills: string[] };
  tree: string;
  budget: { maxIterations: number; deadlineMs: number };
  evidence: Array<"commits" | "tests">;
  /** Task data from an earlier worker, never instructions about tools or rules. */
  handoff?: { text: string; trust: "untrusted" };
}

export function buildWorkOrder(input: WorkOrderInput): WorkOrder {
  const { work, issue, cartridge } = input;
  if (cartridge) {
    const needs: WorkerRequirements = { ...cartridge.requires, skills: [...(cartridge.requires?.skills ?? []), ...cartridge.skills] };
    const check = checkRequirements(needs, input.adapter);
    if (!check.ok) throw new RangeError(`cartridge ${cartridge.name} cannot run on adapter ${input.adapter.adapter}: unsupported: ${check.unsupported}`);
  }
  const order: WorkOrder = {
    task: {
      repo: work.repo, issue: work.issue, branch: work.branch, title: issue.title, body: issue.body, kind: input.kind,
      ...(input.kind === "revise" && input.feedback !== undefined ? { feedback: input.feedback } : {}),
    },
    ...(cartridge ? { cartridge: { name: cartridge.name, modules: [...cartridge.modules], skills: [...cartridge.skills] } } : {}),
    tree: input.tree,
    budget: { ...input.budget },
    evidence: ["commits", "tests"],
  };
  const note = input.handoff;
  if (note?.covered && typeof note.text === "string" && note.text.length > 0 && note.text.length <= HANDOFF_MAX_CHARS) {
    order.handoff = { text: note.text, trust: "untrusted" };
  }
  return order;
}
