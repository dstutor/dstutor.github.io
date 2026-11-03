/**
 * Example gallery, loaded from each tutor's src/data/examples.json so course staff can add or
 * edit examples without touching code. Each example is a small notebook: a markdown note plus
 * one code cell per step. The JSON is validated on load; a bad entry is reported and skipped.
 *
 * Inspired by https://pandastutor.com/
 */

export interface Category {
  id: string;
  name: string;
  description: string;
}

export interface Example {
  id: string;
  title: string;
  description: string;
  category: string;
  operations: string[]; // Methods demonstrated, shown as badges on the card
  markdown: string; // Note shown in the markdown cell above the code
  cells: string[]; // One entry per code cell, run top to bottom
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(x => typeof x === 'string');
}

function validateCategory(raw: unknown, index: number): Category | null {
  const c = raw as Partial<Category> | null;
  if (c && typeof c.id === 'string' && typeof c.name === 'string' && typeof c.description === 'string') {
    return { id: c.id, name: c.name, description: c.description };
  }
  console.error(`examples.json: category #${index} is missing id, name or description`);
  return null;
}

function validateExample(raw: unknown, index: number, categoryIds: Set<string>): Example | null {
  const e = raw as Partial<Example> | null;
  const problems: string[] = [];
  if (!e || typeof e !== 'object') problems.push('not an object');
  else {
    for (const key of ['id', 'title', 'description', 'category', 'markdown'] as const) {
      if (typeof e[key] !== 'string') problems.push(`${key} must be a string`);
    }
    if (!isStringArray(e.operations)) problems.push('operations must be a list of strings');
    if (!isStringArray(e.cells) || e.cells.length === 0) problems.push('cells must be a non-empty list of strings');
    if (typeof e.category === 'string' && !categoryIds.has(e.category)) problems.push(`unknown category "${e.category}"`);
  }
  if (problems.length > 0) {
    console.error(`examples.json: example #${index} (${(e && e.id) || 'no id'}) skipped: ${problems.join('; ')}`);
    return null;
  }
  const ok = e as Example;
  return { id: ok.id, title: ok.title, description: ok.description, category: ok.category, operations: ok.operations, markdown: ok.markdown, cells: ok.cells };
}

export interface Gallery {
  categories: Category[];
  examples: Example[];
  getExampleById(id: string): Example | undefined;
}

/** Validate a tutor's examples.json */
export function loadGallery(data: unknown): Gallery {
  const rawData = (data ?? {}) as { categories?: unknown[]; examples?: unknown[] };
  const categories = (rawData.categories ?? [])
    .map(validateCategory)
    .filter((c): c is Category => c !== null);
  const categoryIds = new Set(categories.map(c => c.id));
  const examples = (rawData.examples ?? [])
    .map((raw, i) => validateExample(raw, i, categoryIds))
    .filter((e): e is Example => e !== null);
  return {
    categories,
    examples,
    getExampleById: (id: string) => examples.find(ex => ex.id === id),
  };
}
