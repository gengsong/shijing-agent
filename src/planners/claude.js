import Anthropic from '@anthropic-ai/sdk';

/**
 * Claude planner: decides the next action from what is visible on the page.
 *
 * Each step is one stateless request (goal + short history + current controls),
 * so a run is cheap, easy to log and easy to replay. Claude only proposes an
 * action; whether the task succeeded is decided by the independent checks in
 * checks.js, never by the model.
 */

export const DEFAULT_MODEL = 'claude-opus-5-5';

const SYSTEM = `You operate a web page on behalf of a first-time user who wants to finish one task.
You see the visible controls of the current page and the actions taken so far.
Choose exactly one next action with the choose_action tool:
- "click" a control by its id,
- "type" text into an input (it is submitted with Enter),
- "give_up" if no visible control can move the task forward.
Act like a real user: take the most direct path you can see, do not repeat an action that did not change anything, and do not do anything the task does not ask for.`;

const TOOL = {
  name: 'choose_action',
  description: 'Choose the single next action on the current page.',
  strict: true,
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['action', 'element_id', 'text', 'reason'],
    properties: {
      action: { type: 'string', enum: ['click', 'type', 'give_up'] },
      element_id: { type: 'integer', description: 'Id of the control to act on; -1 for give_up.' },
      text: { type: 'string', description: 'Text to type for "type"; empty string otherwise.' },
      reason: { type: 'string', description: 'One short sentence: why this action moves the task forward.' },
    },
  },
};

export function createClaudePlanner({ model = DEFAULT_MODEL, effort = 'low', client } = {}) {
  const anthropic = client ?? new Anthropic();
  const usage = { requests: 0, input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 };

  return {
    name: `claude:${model}`,
    usage,
    async next({ goal, successText, view, history }) {
      const page = {
        url: view.url,
        title: view.title,
        headings: view.headings,
        controls: view.items.map(({ id, label, kind, expandable }) => ({ id, label, kind, ...(expandable ? { expandable } : {}) })),
      };
      const done = history.length
        ? history.map((h) => `${h.step}. ${h.action} "${h.label}"${h.text ? ` with "${h.text}"` : ''}`).join('\n')
        : '(none yet)';

      const response = await anthropic.beta.messages.create({
        model,
        max_tokens: 4000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: { effort },
        system: SYSTEM,
        tools: [TOOL],
        tool_choice: { type: 'auto' },
        messages: [{
          role: 'user',
          content: `Task: ${goal}\nThe task is done when ${successText}.\n\nActions so far:\n${done}\n\nCurrent page (JSON):\n${JSON.stringify(page)}`,
        }],
      });

      usage.requests += 1;
      usage.input_tokens += response.usage?.input_tokens ?? 0;
      usage.output_tokens += response.usage?.output_tokens ?? 0;
      usage.cache_read_input_tokens += response.usage?.cache_read_input_tokens ?? 0;

      if (response.stop_reason === 'refusal') {
        return { action: 'give_up', reason: 'The model declined this request.' };
      }
      const call = response.content.find((b) => b.type === 'tool_use' && b.name === TOOL.name);
      if (!call) return { action: 'give_up', reason: 'The model did not choose an action.' };

      const input = call.input;
      if (input.action === 'give_up') return { action: 'give_up', reason: input.reason };
      return { action: input.action, elementId: input.element_id, text: input.text, reason: input.reason };
    },
  };
}
