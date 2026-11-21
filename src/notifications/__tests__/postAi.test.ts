import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildPostAiPrompt, type PostLike } from '../../lib/postAiPrompt.js';

const post = (over: Partial<PostLike>): PostLike => ({
  PostID: 'p', UserId: 'u', Username: 'ayo', NameOfPoster: 'Ayo', Caption: '', Type: 'post', ...over,
});

test('buildPostAiPrompt describes a plain post', () => {
  const text = buildPostAiPrompt({ trigger: post({ Caption: '@ai what is rust?' }), thread: [], replies: [] });
  assert.match(text, /New post from Ayo \(@ayo\), addressed to you:/);
  assert.match(text, /@ai what is rust\?/);
});

test('buildPostAiPrompt includes thread, quoted post, replies, poll and media', () => {
  const text = buildPostAiPrompt({
    trigger: post({ Type: 'comment', Caption: '@ai summarise', Image: ['a.png'], Location: { name: 'Lagos' } }),
    thread: [post({ NameOfPoster: 'Bee', Caption: 'reply 1' }), post({ NameOfPoster: 'Cy', Caption: 'root post' })],
    quoted: post({ NameOfPoster: 'Dee', Caption: 'quoted', Poll: { question: 'Q?', options: ['a', 'b'] } }),
    replies: [post({ NameOfPoster: 'Eve', Caption: 'sibling' })],
  });
  // thread is listed oldest first
  assert.ok(text.indexOf('Cy: root post') < text.indexOf('Bee: reply 1'));
  assert.match(text, /quotes this post by Dee: quoted \[poll: "Q\?" with options a \/ b\]/);
  assert.match(text, /Other replies already posted:\n- Eve: sibling/);
  assert.match(text, /New comment from Ayo/);
  assert.match(text, /\[location: Lagos\]/);
  assert.match(text, /1 attached media file/);
});
