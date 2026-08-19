export function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/** Appends a short random suffix to reduce collisions for user-chosen
 * names (organization names, branch names) without a retry loop. Callers
 * that need a hard uniqueness guarantee should still catch the unique
 * constraint violation and retry. */
export function slugifyWithSuffix(input: string): string {
  const base = slugify(input) || 'org';
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${base}-${suffix}`;
}
