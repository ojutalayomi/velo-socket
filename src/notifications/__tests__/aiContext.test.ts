import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildAiContext, buildGroupContext } from '../../lib/aiContext.js';

test('buildGroupContext lists name, description, members and admins', () => {
  const text = buildGroupContext({
    name: 'AyoCodex',
    description: 'Coding community',
    memberCount: 2,
    admins: ['Ayo'],
    members: [{ name: 'Ayo', username: 'ayo', bio: 'dev' }, { name: 'Bee' }],
    asker: { name: 'Bee' },
  });
  assert.match(text, /Name: AyoCodex/);
  assert.match(text, /Description: Coding community/);
  assert.match(text, /Ayo \(@ayo\) - dev; Bee/);
  assert.match(text, /Admins: Ayo/);
  assert.match(text, /asking you right now: Bee/);
});

test('buildGroupContext notes members beyond the listed cap', () => {
  const members = Array.from({ length: 45 }, (_, i) => ({ name: `U${i}` }));
  assert.match(buildGroupContext({ memberCount: 100, admins: [], members }), /and 60 more/);
});

test('buildAiContext prefixes names and includes the quoted message', () => {
  const turns = buildAiContext(
    [
      { _id: 'a', content: 'hello', sender: { id: '1', name: 'Ayo' } },
      { _id: 'b', content: 'hi back', quotedMessageId: 'a', sender: { id: '2', name: 'Bee' } },
      { _id: 'c', content: 'answer', sender: { id: 'bot' } },
    ],
    'bot'
  );
  assert.equal(turns[0].content, 'Ayo: hello');
  assert.match(turns[1].content, /^Bee: \(replying to Ayo: "hello"\) hi back$/);
  assert.equal(turns[2].role, 'assistant');
});
