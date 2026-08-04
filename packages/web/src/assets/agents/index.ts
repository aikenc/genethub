import type { AgentAssetVariants } from "../../presentation/catalog/types";

import acp from "./acp.svg?url";
import cursorDark from "./cursor-dark.svg?url";
import cursorLight from "./cursor-light.svg?url";
import genet from "./genet.svg?url";
import goose from "./goose.svg?url";
import opencodeDark from "./opencode-dark.svg?url";
import opencodeLight from "./opencode-light.svg?url";

export const agentAssets = {
  genet: { default: genet },
  opencode: { default: opencodeDark, dark: opencodeDark, light: opencodeLight },
  cursor: { default: cursorDark, dark: cursorDark, light: cursorLight },
  acp: { default: acp },
  goose: { default: goose, surface: "light" },
} as const satisfies Record<string, AgentAssetVariants>;

export type AgentAssetId = keyof typeof agentAssets;
