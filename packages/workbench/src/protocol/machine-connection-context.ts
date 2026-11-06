import { createContext } from "react";
import type { MachineConnections } from "./machine-connections";

/** Full Workbench authority is never inherited by display-only share pages. */
export const MachineConnectionsContext = createContext<MachineConnections | null>(null);
