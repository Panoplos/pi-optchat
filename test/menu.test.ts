import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Theme } from '@earendil-works/pi-coding-agent';
import { optchatMenu, type MenuAction } from '../src/menu.ts';
import { defaults } from '../src/profiles.ts';

const plain = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as unknown as Theme;
const status = { profile: 'personal', messages: 5251, pending: 1, error: 'Rate limited' };

test('/optchat shows the profile status as aligned rows and returns the chosen action', () => {
  const chosen: (MenuAction | undefined)[] = [];
  const menu = optchatMenu(plain, 'OptChat v1.2.3', status, action => chosen.push(action));
  const lines = menu.render(80).map(line => line.trimEnd());
  assert.ok(lines.includes(' OptChat v1.2.3 · personal'));
  assert.ok(lines.includes(' Memory     5,251 messages · 1 pending'));
  assert.ok(lines.includes(` Compactor  Pi's model (follow)`), 'the compactor follows Pi until pinned');
  assert.ok(lines.includes(' Summaries failing: Rate limited'));
  const pinned = optchatMenu(plain, 'OptChat', { ...status, compactor: defaults.compactor ?? { provider: 'anthropic', model: 'claude-sonnet-5-5', thinking: 'medium' } },
    () => {}).render(80).map(line => line.trimEnd());
  assert.ok(pinned.includes(' Compactor  anthropic/claude-sonnet-5-5 · medium'), 'a pinned model is shown as it is');
  menu.handleInput('j'); menu.handleInput('\r');
  menu.handleInput('\x1b');
  assert.deepEqual(chosen, ['settings', undefined]);
});

test('/optchat without a profile says so and keeps every action', () => {
  const lines = optchatMenu(plain, 'OptChat', undefined, () => {}).render(80).map(line => line.trimEnd());
  assert.ok(lines.includes(' OptChat') && lines.includes(' No active profile'));
  assert.ok(lines.some(line => line.includes('import') && line.includes('Import history')));
});
