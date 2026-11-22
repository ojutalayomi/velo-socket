import test from 'node:test';
import assert from 'node:assert/strict';

import { deriveMessageType } from '../../lib/messageType.js';
import { messageDisplayText } from '../../lib/postExtras.js';

const file = (type: string, name = 'f') => ({ type, name });

test('URL-only is a Link; a URL in a sentence is Text', () => {
  assert.equal(deriveMessageType({ content: 'https://velo.app/x' }), 'Link');
  assert.equal(deriveMessageType({ content: 'see https://velo.app' }), 'Text');
});

test('text defaults to Text, Markdown only on request, and a claimed Link is ignored', () => {
  assert.equal(deriveMessageType({ content: 'hi' }), 'Text');
  assert.equal(deriveMessageType({ content: '**hi**', requested: 'Markdown' }), 'Markdown');
  assert.equal(deriveMessageType({ content: 'hi', requested: 'Link' }), 'Text');
  assert.equal(deriveMessageType({ attachments: [file('image/png')], requested: 'Poll' }), 'Poll');
});

test('attachment-only messages are typed by their kind', () => {
  assert.equal(deriveMessageType({ attachments: [file('image/png'), file('image/gif')] }), 'Image');
  assert.equal(deriveMessageType({ attachments: [file('video/mp4')] }), 'Video');
  assert.equal(deriveMessageType({ attachments: [file('audio/mpeg', 'a.mp3')] }), 'Audio');
  assert.equal(deriveMessageType({ attachments: [file('audio/mpeg', 'voice-note-1-5s.mp3')] }), 'VoiceNote');
  assert.equal(deriveMessageType({ attachments: [file('image/png'), file('application/pdf')] }), 'File');
  assert.equal(deriveMessageType({ content: 'cap', attachments: [file('image/png')] }), 'Text');
});

test('empty attachment messages get a readable preview', () => {
  assert.equal(messageDisplayText('VoiceNote', ''), '🎤 Voice message');
  assert.equal(messageDisplayText('Image', undefined), '📷 Photo');
  assert.equal(messageDisplayText('Text', 'hello'), 'hello');
});

import { canonicalLocationContent, contactContent, requestedContactId } from '../../lib/postExtras.js';

test('location messages are validated and previewed', () => {
  assert.equal(canonicalLocationContent('not json'), null);
  assert.equal(canonicalLocationContent(JSON.stringify({ name: '  ' })), null);
  assert.equal(
    canonicalLocationContent(JSON.stringify({ name: 'Lagos', lat: 6.5, lng: 3.3, extra: 'x' })),
    JSON.stringify({ name: 'Lagos', lat: 6.5, lng: 3.3 })
  );
  // out-of-range coordinates are dropped, the place name is kept
  assert.equal(canonicalLocationContent(JSON.stringify({ name: 'X', lat: 99, lng: 3 })), JSON.stringify({ name: 'X' }));
  assert.equal(messageDisplayText('Location', JSON.stringify({ name: 'Lagos' })), '📍 Lagos');
});

test('a shared contact takes only the id from the sender', () => {
  assert.equal(requestedContactId(JSON.stringify({ userId: '507f1f77bcf86cd799439011', name: 'Fake' })), '507f1f77bcf86cd799439011');
  assert.equal(requestedContactId(JSON.stringify({ userId: 'nope' })), null);
  assert.equal(requestedContactId('x'), null);
  const content = contactContent({ _id: { toString: () => 'abc' }, firstname: 'Ada', lastname: 'L', username: 'ada', verified: true });
  assert.deepEqual(JSON.parse(content), { userId: 'abc', name: 'Ada L', username: 'ada', displayPicture: '', verified: true });
  assert.equal(messageDisplayText('Contact', content), '👤 Ada L');
});

import { canonicalKlipyContent } from '../../lib/postExtras.js';

test('GIFs and stickers must point at KLIPY hosts, and their URLs are kept as given', () => {
  const good = { slug: 's', title: 'Hi', url: 'https://static.klipy.com/a/b.webp?x=1&y=2', previewUrl: 'https://static1.klipy.com/c.webp', width: 320, height: 240 };
  const out = JSON.parse(canonicalKlipyContent(JSON.stringify(good)) as string);
  assert.equal(out.url, good.url);
  assert.equal(out.provider, 'klipy');
  assert.equal(out.width, 320);

  for (const url of [
    'http://static.klipy.com/a.gif',
    'https://evil.com/a.gif',
    'https://klipy.com.evil.com/a.gif',
    'https://evilklipy.com/a.gif',
    'javascript:alert(1)',
  ]) {
    assert.equal(canonicalKlipyContent(JSON.stringify({ ...good, url })), null, url);
  }
  assert.equal(canonicalKlipyContent(JSON.stringify({ ...good, previewUrl: 'https://evil.com/p.png' })), null);
  assert.equal(canonicalKlipyContent('nope'), null);
  assert.equal(messageDisplayText('AnimatedGIF', 'x'), '🎞 GIF');
  assert.equal(messageDisplayText('Sticker', 'x'), '🏷 Sticker');
});
