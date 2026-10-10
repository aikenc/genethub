import type { AgentAssetVariants } from "../../presentation/catalog/types";

import cursorDark from "./cursor-dark.svg?url";
import cursorLight from "./cursor-light.svg?url";
import genet from "./genet.svg?url";

export const agentAssets = {
  genet: { default: genet },
  cursor: { default: cursorDark, dark: cursorDark, light: cursorLight },
} as const satisfies Record<string, AgentAssetVariants>;

export type AgentAssetId = keyof typeof agentAssets;
