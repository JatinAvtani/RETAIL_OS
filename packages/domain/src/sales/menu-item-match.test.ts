import { describe, expect, it } from 'vitest';
import { suggestMenuItemMatches } from './menu-item-match';

describe('suggestMenuItemMatches', () => {
  it('ranks an exact (case/punctuation-insensitive) match first with the maximum score', () => {
    const suggestions = suggestMenuItemMatches('Iced Latte', [
      { id: 'a', name: 'Cappuccino' },
      { id: 'b', name: 'iced latte' },
      { id: 'c', name: 'Latte' },
    ]);
    expect(suggestions[0]).toEqual({ menuItemId: 'b', name: 'iced latte', score: 1 });
  });

  it('includes a genuine partial word match but excludes a completely unrelated name', () => {
    const suggestions = suggestMenuItemMatches('Blueberry Muffin - Large', [
      { id: 'a', name: 'Blueberry Muffin' },
      { id: 'b', name: 'Chocolate Croissant' },
    ]);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]?.menuItemId).toBe('a');
  });

  it('is insensitive to word order', () => {
    const suggestions = suggestMenuItemMatches('Latte, Iced', [{ id: 'a', name: 'Iced Latte' }]);
    expect(suggestions[0]?.menuItemId).toBe('a');
    expect(suggestions[0]?.score).toBeGreaterThan(0.5);
  });

  it('excludes candidates with zero token overlap', () => {
    const suggestions = suggestMenuItemMatches('Espresso', [{ id: 'a', name: 'Blueberry Muffin' }]);
    expect(suggestions).toEqual([]);
  });

  it('returns an empty array for an empty candidate list', () => {
    expect(suggestMenuItemMatches('Espresso', [])).toEqual([]);
  });

  it('returns an empty array when the POS item name is empty', () => {
    expect(suggestMenuItemMatches('', [{ id: 'a', name: 'Espresso' }])).toEqual([]);
  });

  it('never mutates the input candidates array', () => {
    const candidates = [
      { id: 'a', name: 'Zebra Cake' },
      { id: 'b', name: 'Apple Pie' },
    ];
    const snapshot = [...candidates];
    suggestMenuItemMatches('Apple Pie', candidates);
    expect(candidates).toEqual(snapshot);
  });
});
