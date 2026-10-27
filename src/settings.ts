import { NODE } from './memory.ts';

/** Per-profile choices where OptChat departs from Victor's recipe. Each default is the recipe's behaviour unless noted. */
export const SETTINGS = {
  subagentLevels: { kind: 'number', label: 'Subagent levels', default: 1, min: 1, unit: '',
    description: 'How deep subagents can nest. 1: only the main agent starts them.',
    applies: 'Applies to new or resumed subagents.' },
  maxAgents: { kind: 'number', label: 'Max active agents', default: 8, min: 1, unit: '',
    description: 'Subagents running at once, all levels together. Also caps chain depth.',
    applies: 'Applies to the next spawn.' },
  groupReports: { kind: 'toggle', label: 'Group subagent reports', default: false,
    description: 'On: subagents from one spawn report together, once the last finishes. Off: each reports when done (Victor\'s recipe).',
    applies: 'Applies to the next spawn.' },
  previousExchange: { kind: 'toggle', label: 'Previous exchange', default: true,
    description: 'Send your last request and its answer in full with the next turn, so follow-ups see the exact wording. Off: memory view only (Victor\'s recipe).',
    applies: 'Applies from the next turn.' },
  previousExchangeKB: { kind: 'number', label: 'Previous exchange limit', default: 16, min: 1, unit: 'KB',
    description: 'A larger exchange, usually a big paste, is left out; the model zooms instead.',
    applies: 'Applies from the next turn.' },
  memorySearch: { kind: 'toggle', label: 'Memory search', default: false,
    description: 'Lets agents search original messages by plain text. Off: zoom and date only (Victor\'s recipe). Toggling re-caches the prompt once.',
    applies: 'Applies from the next turn and to new or resumed subagents.' },
  summaryAcceptBytes: { kind: 'number', label: 'Summary size tolerance', default: NODE * 1.25, min: NODE, unit: 'bytes',
    description: `Summary lines up to this size are kept instead of retried (the compactor aims for ${NODE}). ${NODE}: strict (Victor's recipe).`,
    applies: 'Applies to the next summary.' },
  jobs: { kind: 'number', label: 'Summaries at once', default: 8, min: 1, max: 64, unit: '',
    description: 'Summaries built in parallel. Higher is faster, slightly less accurate and harder on rate limits; keep it below your provider\'s parallel cap.',
    applies: 'Applies to the next import, and to chat after /reload.' },
  refreshAt: { kind: 'percent', label: 'Turn refresh threshold', default: 0.3, min: 0, max: 0.9,
    description: 'When a turn fills this share of the context window, it moves into memory and continues in a fresh window. 0%: off (Victor\'s recipe). OPTCHAT_REFRESH_AT overrides it.',
    applies: 'Applies from the next call and to new or resumed subagents.' },
} as const;

export type SettingKey = keyof typeof SETTINGS;
export type Settings = { -readonly [K in SettingKey]: (typeof SETTINGS)[K]['default'] extends boolean ? boolean : number };
export type NumberKey = { [K in SettingKey]: Settings[K] extends number ? K : never }[SettingKey];
export const SETTING_KEYS = Object.keys(SETTINGS) as SettingKey[];
export const isNumberKey = (key: SettingKey): key is NumberKey => SETTINGS[key].kind !== 'toggle';
/** A percent setting is saved as a fraction of 1 and shown as a percentage. */
export const percent = (fraction: number) => `${Math.round(fraction * 1000) / 10}%`;

/** Why a value can't be used, or undefined if it can. Numbers are whole and within their range. */
export function invalid(key: SettingKey, value: unknown) {
  if (isNumberKey(key)) {
    const spec = SETTINGS[key];
    if (spec.kind === 'percent') return typeof value === 'number' && value >= spec.min && value <= spec.max ? undefined
      : `${spec.label} must be from ${percent(spec.min)} to ${percent(spec.max)}.`;
    const { label, min, max = Infinity }: { label: string; min: number; max?: number } = spec;
    return Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max ? undefined
      : `${label} must be a whole number ${max === Infinity ? `of ${min} or more` : `from ${min} to ${max}`}.`;
  }
  return typeof value === 'boolean' ? undefined : `${SETTINGS[key].label} must be true or false.`;
}

/** Missing keys take their defaults, so config files written before a setting existed keep working. */
export function readSettings(value: Record<string, unknown>): Settings {
  // "Summaries at once" was `importJobs` while it only covered imports; an older config.json keeps its value.
  if (!Object.hasOwn(value, 'jobs') && Object.hasOwn(value, 'importJobs')) value = { ...value, jobs: value.importJobs };
  return Object.fromEntries(SETTING_KEYS.map(key => {
    const raw = Object.hasOwn(value, key) ? value[key] : SETTINGS[key].default, problem = invalid(key, raw);
    if (problem) throw new Error(problem);
    return [key, raw];
  })) as Settings;
}
export const DEFAULT_SETTINGS = readSettings({});
