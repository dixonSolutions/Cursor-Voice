export interface ToolActivityEvent {
  sessionKey: string;
  tool: string;
  phase: 'start' | 'done' | 'error';
  label: string;
  detail?: string;
}
