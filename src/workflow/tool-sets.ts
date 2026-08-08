import { getDefaultWorkflowToolNames } from "../tools/tool-catalog.js";

/**
 * Tool visibility sets shared by chat modes. They are policy/catalog data,
 * not a phase plan and do not start the removed workflow runtime.
 */
export const READ_TOOLS: string[] = getDefaultWorkflowToolNames("read");
export const VERIFY_TOOLS: string[] = getDefaultWorkflowToolNames("verify");
export const WRITE_TOOLS: string[] = getDefaultWorkflowToolNames("write");
