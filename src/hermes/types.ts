/** Hermes event object as delivered by the local API server. */
export type HermesEvent = Record<string, unknown> & {
  event?: string;
  type?: string;
  run_id?: string;
  output?: string;
  usage?: unknown;
};

/** Hermes run-start response. */
export interface HermesRunResponse {
  run_id?: string;
  status?: string;
}

/** Hermes model list response. */
export interface HermesModelsResponse {
  data?: Array<{ id?: string }>;
}

/** Hermes capabilities response. */
export interface HermesCapabilitiesResponse {
  model?: string;
  features?: unknown;
}
