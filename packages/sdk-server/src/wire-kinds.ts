/** Economy flow types ([004-economy §3]). Shared by the server economy verb. */
export const FLOW_TYPES = ['source', 'sink'] as const;
export type FlowType = (typeof FLOW_TYPES)[number];
