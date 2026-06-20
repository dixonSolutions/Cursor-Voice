export interface CallSessionPlugin {
  startCall(): Promise<void>;
  endCall(): Promise<void>;
  isCallActive(): Promise<{ active: boolean }>;
}

export interface IncomingCallPayload {
  title: string;
  body: string;
  requestId?: string;
}
