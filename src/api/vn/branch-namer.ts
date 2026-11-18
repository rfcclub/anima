/**
 * Branch Namer — derives a human-readable branch name from choice value.
 * Applies slug sanitization and deduplication against existing branch names.
 */

export interface BranchNamerInput {
  value: string;
  label?: string;
  existingNames?: string[];
}

/**
 * Derive a unique branch name from a choice value or label.
 * Rules:
 * - Max 40 chars
 * - Lowercase, replace spaces/special chars with underscore
 * - Collapse consecutive underscores
 * - Strip leading/trailing underscores
 * - If name exists in existingNames, append _2, _3, etc.
 * - Fallback to "branch_N" if sanitized name is empty
 */
export function deriveBranchName(input: BranchNamerInput): string {
  let name = input.value || input.label || "";

  // Sanitize: lowercase, replace non-alphanumeric with underscore
  name = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 40);

  // Fallback if sanitization emptied the name
  if (!name) {
    name = "branch";
  }

  // Deduplicate against existing names
  const existing = new Set(input.existingNames || []);
  if (existing.has(name)) {
    let i = 2;
    while (existing.has(`${name}_${i}`)) {
      i++;
    }
    name = `${name}_${i}`;
  }

  return name;
}
