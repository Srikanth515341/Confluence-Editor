// Input pipeline (Phase 12). API Spec §7.4 (inputType dispatch table),
// §7.4.3 (grapheme boundaries), §7.4.4 (bind flag). See inputPipeline.ts's
// own doc comment for the full dispatch table and Scope-IN's unconditional
// preventDefault rule.

export { attachInputPipeline, handleBeforeInput, type InputPipelineDeps } from "./inputPipeline.js";
export {
  attachCompositionHandlers,
  CompositionController,
  type CompositionControllerDeps,
} from "./compositionController.js";
export {
  clusterAfter,
  clusterBefore,
  lineStartBefore,
  wordAfter,
  wordBefore,
  type TextSpan,
} from "./graphemeSegmentation.js";
