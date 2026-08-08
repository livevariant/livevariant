export {
  TOOLS,
  buildTest,
  findTool,
  generatePriors,
  getStats,
  inspectTest,
  uploadImage,
  variantBrief,
  type ToolName
} from "./tools.js";
export {
  renderAuthMd,
  renderLlmsTxt,
  renderMcpInstructions,
  renderRobotsTxt,
  renderSkillMd,
  SKILL_DESCRIPTION
} from "./docs.js";
export {
  ToolInputError,
  defineTool,
  toolPath,
  type ToolContext,
  type ToolDefinition,
  type ToolErrorStatus
} from "./types.js";
/**
 * The zod instance these schemas are built with, re-exported so an
 * embedding host can extend a tool's `input` (adding its own tenant or
 * scope argument, say) without importing zod itself and risking a second
 * copy in the program. Two zod copies in one TypeScript program is not a
 * theoretical problem: it turns structural comparison of schema types
 * into an 8 GB typecheck.
 *
 * Note that @livevariant/core uses zod/mini, because it ships to browsers.
 * This one is classic zod: the registry needs .describe() and JSON Schema
 * emission, and none of it reaches a browser bundle.
 */
export { z } from "zod";
export {
  resolveTest,
  resolveVariantIndex,
  type ResolvedTest
} from "./resolve.js";
export {
  buildOpenApiDocument,
  swaggerPage,
  type OpenApiOptions
} from "./openapi.js";
