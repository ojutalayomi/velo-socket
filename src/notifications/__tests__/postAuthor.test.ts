import assert from 'node:assert/strict';
import test from 'node:test';

import { withAuthor, withoutAuthor } from '../../lib/postAuthor.js';

test('the current account wins over the stored copy', () => {
  const post = withAuthor(
    { NameOfPoster: 'Old', Username: 'old', DisplayPicture: 'old.png', Verified: false },
    { name: 'New', username: 'new', displayPicture: 'new.png', verified: true }
  );
  assert.deepEqual(
    [post.NameOfPoster, post.Username, post.DisplayPicture, post.Verified],
    ['New', 'new', 'new.png', true]
  );
});

test('a deleted account falls back to the stored copy, then to a label', () => {
  assert.equal(withAuthor({ NameOfPoster: 'Old' }, null).NameOfPoster, 'Old');
  assert.equal(withAuthor({}, null).NameOfPoster, 'Deleted user');
});

test('saved posts keep only who wrote them', () => {
  const saved = withoutAuthor({ UserId: 'u', Caption: 'hi', NameOfPoster: 'A', Username: 'a', DisplayPicture: '', Verified: true });
  assert.deepEqual(saved, { UserId: 'u', Caption: 'hi' });
});
