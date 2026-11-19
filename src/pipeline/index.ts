/** Public surface of `pipeline` (A-2): the review run and its pure helpers. */
export { runReview, dedupeAgainstComments, type ReviewRunOptions, type ReviewRunResult, type RecheckOutcome } from "./run.ts";
export * from "./config.ts";
export { loadKnowledge, knowledgeFileList, isKnowledgePath, type Knowledge, type KnowledgeOverride } from "./knowledge.ts";
export { loadMethod, PI_REVIEW_DIR, type Method } from "./method.ts";
export { buildContext, neutralizeDelimiters } from "./context.ts";
export { chunkByDirectory, deterministicPass, patchFileName, type Chunk, type PatchFile } from "./deterministic.ts";
export { derivePriorState, openPriorFindings, parseCommentHead, type PriorFinding, type PriorState } from "./prior.ts";
export { buildReview, findingCommentBody, inlineComment, recheckReplyBody } from "./publish.ts";
export { snapshotLookup } from "./lookup.ts";
export * from "./skip.ts";
export { historyTools, HISTORY_TOOL_NAMES, type HistoryScope } from "./history-tools.ts";
