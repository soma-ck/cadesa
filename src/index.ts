/** Cascadio as a library. The CLI and MCP server are thin wrappers over these. */
export { compile, VERSION } from "./compile.js";
export { CascadioError, formatDiagnostic, type Diagnostic } from "./diagnostics.js";
export { loadSource, loadSourceFile, type Source } from "./load.js";
export { validate } from "./validate.js";
export { parseFixture, type Fixture, type FixtureNode } from "./fixture.js";
export { layout, walk, type Box, type Issue, type Layout } from "./engine/layout.js";
export { metricsFor, layoutText } from "./engine/text.js";
export { modelOf, render, whatif, diffLayouts, parseSet, type Change, type WhatIf } from "./project.js";
export { explain, type Explanation } from "./explain.js";
export { check, contrast, type Finding } from "./check.js";
export { lift, type LiftResult, type Unlifted } from "./lift/lift.js";
export { impact, type WidthImpact } from "./lift/impact.js";
export { createServer } from "./mcp.js";
export type { Model } from "./model.js";
