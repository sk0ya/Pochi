import { describe, expect, it } from 'vitest';
import { CATEGORIES, findTemplate, TEMPLATES, templatesByCategory } from './templates';

describe('templates: category/data loading', () => {
  it('loads every category with an id/name/icon, and every template under a real category', () => {
    expect(CATEGORIES.length).toBeGreaterThan(0);
    const categoryIds = new Set(CATEGORIES.map((c) => c.id));
    for (const cat of CATEGORIES) {
      expect(cat.id).toBeTruthy();
      expect(cat.name).toBeTruthy();
      expect(cat.icon).toBeTruthy();
    }
    expect(TEMPLATES.length).toBeGreaterThan(0);
    for (const tpl of TEMPLATES) {
      expect(categoryIds.has(tpl.categoryId)).toBe(true);
      expect(tpl.id.startsWith(`${tpl.categoryId}-`)).toBe(true);
      expect(tpl.name).toBeTruthy();
    }
  });

  it('has no duplicate template ids', () => {
    const ids = TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('groups multiple stamps under one category (town: 家1/家2/...)', () => {
    const townTemplates = templatesByCategory('town');
    expect(townTemplates.length).toBeGreaterThanOrEqual(2);
    expect(townTemplates.slice(0, 2).map((t) => t.id)).toEqual(['town-1', 'town-2']);
    expect(findTemplate('town-1')?.name).toBe('家1');
    expect(findTemplate('town-2')?.name).toBe('家2');
  });

  it('findTemplate returns undefined for an unknown id', () => {
    expect(findTemplate('does-not-exist')).toBeUndefined();
  });

  it('orders TEMPLATES ("全" / show-all) by CATEGORIES order, not categoryId-alphabetical', () => {
    // categoryId-alphabetical would put "cloud" before "house" — this checks display order
    // (CATEGORIES) is what TEMPLATES actually follows instead.
    const categoryOrder = CATEGORIES.map((c) => c.id);
    const seenOrder = [...new Set(TEMPLATES.map((t) => t.categoryId))];
    expect(seenOrder).toEqual(categoryOrder);
  });
});
