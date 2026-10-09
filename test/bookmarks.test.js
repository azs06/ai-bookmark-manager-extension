import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flattenBookmarkTree } from '../lib/bookmarks.js';

test('skips browser-defined root folders regardless of locale', () => {
  const tree = [{
    id: '0',
    title: '',
    children: [
      {
        id: '1',
        title: 'Barre de favoris',
        children: [
          { id: '10', title: 'Top', url: 'https://top.example' },
          {
            id: '11',
            title: 'Work',
            children: [
              { id: '12', title: 'Docs', url: 'https://docs.example' },
              { id: '13', title: 'Infra', children: [{ id: '14', title: '', url: 'http://grafana.local' }] },
            ],
          },
        ],
      },
      {
        id: '2',
        title: 'Autres favoris',
        children: [
          { id: '20', title: 'Script', url: 'javascript:alert(1)' },
          { id: '21', title: 'Read later', children: [{ id: '22', title: 'Post', url: 'https://blog.example/post' }] },
        ],
      },
    ],
  }];

  assert.deepEqual(flattenBookmarkTree(tree), [
    { url: 'https://top.example', title: 'Top', tags: [] },
    { url: 'https://docs.example', title: 'Docs', tags: ['Work'] },
    { url: 'http://grafana.local', title: null, tags: ['Work', 'Infra'] },
    { url: 'https://blog.example/post', title: 'Post', tags: ['Read later'] },
  ]);
});
