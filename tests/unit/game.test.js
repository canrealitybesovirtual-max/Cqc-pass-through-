import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game, S } from '../../src/app/Game.js';

test('happy path boot → menu → entering → xr → menu', () => {
  const g = new Game();
  const seen = [];
  g.on((next, prev, ev) => seen.push(`${prev}>${ev}>${next}`));
  assert.equal(g.state, S.BOOT);
  assert.ok(g.send('ready'));
  assert.ok(g.send('enter', { mode: 'probe' }));
  assert.equal(g.mode, 'probe');
  assert.ok(g.send('started'));
  assert.equal(g.state, S.XR);
  assert.ok(g.send('ended'));
  assert.equal(g.state, S.MENU);
  assert.deepEqual(seen, ['boot>ready>menu', 'menu>enter>entering', 'entering>started>xr', 'xr>ended>menu']);
});

test('failed request returns to menu', () => {
  const g = new Game();
  g.send('ready');
  g.send('enter', { mode: 'play' });
  assert.ok(g.send('failed'));
  assert.equal(g.state, S.MENU);
});

test('illegal events are rejected and remembered', () => {
  const g = new Game();
  assert.equal(g.send('started'), false);
  assert.equal(g.send('ended'), false);
  g.send('ready');
  assert.equal(g.send('ready'), false);
  assert.deepEqual(g.rejected, ['boot:started', 'boot:ended', 'menu:ready']);
});

test('pause reasons only apply in xr and clear on exit', () => {
  const g = new Game();
  g.send('ready');
  assert.equal(g.setPause('hidden', true), false);
  g.send('enter', { mode: 'play' });
  g.send('started');
  assert.equal(g.setPause('hidden', true), true);
  assert.equal(g.setPause('menu', true), false);
  assert.ok(g.paused);
  g.setPause('hidden', false);
  assert.ok(g.paused);
  g.send('ended');
  assert.equal(g.paused, false);
});
