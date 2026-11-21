/** The thirteen tools of the Studio_MCP (`daemonize mcp`), in the order of the design. Names only: no behavior here. */
export const STUDIO_MCP_TOOL_NAMES = [
  'list_actions',
  'get_action',
  'list_credentials',
  'get_activity',
  'start_recording',
  'get_recording_status',
  'finish_recording',
  'compile',
  'test_action',
  'preview_kiro_install',
  'install_to_kiro',
  'update_action',
  'delete_action',
] as const;

export type StudioMcpToolName = (typeof STUDIO_MCP_TOOL_NAMES)[number];

/** The tools the Builder_Agent may call without a question (reads and recording). */
export const STUDIO_MCP_ALLOWED_TOOLS: ReadonlyArray<StudioMcpToolName> = [
  'list_actions',
  'get_action',
  'list_credentials',
  'get_activity',
  'start_recording',
  'get_recording_status',
  'finish_recording',
];

/** The tools the Builder_Agent must ask about first. */
export const STUDIO_MCP_ASK_TOOLS: ReadonlyArray<StudioMcpToolName> = [
  'compile',
  'test_action',
  'preview_kiro_install',
  'install_to_kiro',
  'update_action',
  'delete_action',
];
