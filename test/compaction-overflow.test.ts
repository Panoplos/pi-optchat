import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import optchat from '../src/index.ts';

type Handler = (event: unknown, ctx: unknown) => unknown;
const noop = () => {};

/** The extension's handlers, without a session: only the ones this file exercises are called. */
function loaded() {
  const handlers = new Map<string, Handler>();
  const notices: string[] = [];
  const pi = new Proxy({} as Record<string, unknown>, {
    get(_target, key) {
      if (key === 'on') return (name: string, handler: Handler) => { handlers.set(name, handler); return noop; };
      if (key === 'getFlag') return () => undefined;
      if (key === 'getActiveTools' || key === 'getAllTools' || key === 'getCommands') return () => [];
      return noop;
    },
  });
  optchat(pi as unknown as ExtensionAPI);
  const ctx = { ui: { notify: (text: string) => { notices.push(text); } } };
  return { handlers, notices, ctx };
}

test('compaction stays off for manual and threshold compactions', () => {
  for (const reason of ['manual', 'threshold'] as const) {
    const { handlers, notices, ctx } = loaded();
    const result = handlers.get('session_before_compact')!({ reason }, ctx);
    assert.deepEqual(result, { cancel: true }, `${reason} compaction is cancelled`);
    assert.match(notices[0] ?? '', /OptChat manages history between turns/);
  }
});

test('overflow recovery is left to Pi, so a refused request is retried instead of ending the turn', () => {
  const { handlers, notices, ctx } = loaded();
  assert.equal(handlers.get('session_before_compact')!({ reason: 'overflow' }, ctx), undefined);
  assert.deepEqual(notices, [], 'no notice: the turn continues');
});
