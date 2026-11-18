import { DISCUSSION_QUERIES, type ReviewDiscussionQuery } from "./discussion";
import { createReviewHttpSession, ReviewHttpError, validReviewBranch, type ReviewHttpDependencies } from "./http-session";

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const opaque = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9+/_=:-]{1,4096}$/.test(value);

/** Unwired native query adapter. Only fixed read documents can reach POST /graphql; no token issuer. */
export function createReviewGitHubDiscussion(repo: string, number: number, baseBranch: string,
  deps: ReviewHttpDependencies): ReviewDiscussionQuery {
  if (typeof repo !== "string" || !/^rfcclub\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(repo)
    || !Number.isSafeInteger(number) || number <= 0 || number > 2147483647
    || typeof baseBranch !== "string" || !validReviewBranch(baseBranch)) throw new ReviewHttpError("config");
  const subject = { owner: "rfcclub", name: repo.slice(8), number, baseRef: `refs/heads/${baseBranch}` };
  const read = createReviewHttpSession<{ document: string; variables: unknown }>(deps, {
    requests: 200,
    prepare({ document, variables }) {
      const kind = (Object.keys(DISCUSSION_QUERIES) as Array<keyof typeof DISCUSSION_QUERIES>)
        .find(key => document === DISCUSSION_QUERIES[key]);
      if (!kind || !object(variables)) return;
      const keys = [...Object.keys(subject), ...(kind === "anchor" ? [] : ["after"]),
        ...(kind === "threadComments" ? ["threadId"] : [])];
      const own = Reflect.ownKeys(variables);
      if (own.length !== keys.length || own.some(key => typeof key !== "string" || !keys.includes(key))) return;
      // Capture each value once before any async callback; caller mutation cannot rebind the request.
      const copy = Object.fromEntries(keys.map(key => [key, variables[key]]));
      if (Object.entries(subject).some(([key, value]) => copy[key] !== value)
        || (kind !== "anchor" && copy.after !== null && !opaque(copy.after))
        || (kind === "threadComments" && !opaque(copy.threadId))) return;
      return { path: "/graphql", method: "POST", body: JSON.stringify({ query: document, variables: copy }) };
    },
    accept: value => object(value) && object(value.data)
      && (value.errors === undefined || (Array.isArray(value.errors) && value.errors.length === 0)),
  });
  return (document, variables, signal) => read({ document, variables }, signal);
}
