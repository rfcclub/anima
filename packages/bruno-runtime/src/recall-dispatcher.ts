/** Compatibility exports; implementation is tenant-scoped in identity-runtime. */
export {
  defaultClassifier,
  HeuristicQueryClassifier,
  JevQueryClassifier,
  LLMQueryClassifier,
  recall,
  type QueryClassifier,
  type RecallDeps,
  type RecallResult,
  type RecallSource,
} from "../../identity-runtime/src/bruno-recall-policy.ts";
