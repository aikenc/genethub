import { describe, expect, it } from "vitest";

import { encodeTabsQuery, expandLocator, locatorsMatch, shortenLocator } from "./locator";
import {
  formatWorkbenchHref,
  formatWorkbenchPath,
  NEW_SESSION_ID,
  parseWorkbenchHref,
  parseWorkbenchPath,
  scopedWorkbenchLocation,
} from "./workbench";

const DEVICE = "dev_7k2";
const WORKSPACE = "w_docs";
const SESSION = "s_ab12cd34ef56";
const MACHINE = "m_17ef85c530554af9bb7de6c19116aff0";
const PROJECT = "w_cb37e25bcb05407391549e3c1b4913a1";
const TALK = "s_a1b2c3d4e5f6789012345678abcdef01";
const ROOT = "r_c6c2ec07578d4e4a85bb3b723d8ba220";

describe("workbench locators", () => {
  it("round-trips a device, workspace and session on the legacy /d/ spelling", () => {
    const location = {
      deviceHandle: DEVICE,
      workspaceId: WORKSPACE,
      sessionId: SESSION,
      preview: null,
      dialog: null,
    };
    const path = formatWorkbenchPath(location);
    expect(path).toBe(`/d/${DEVICE}/w/${WORKSPACE}/s/${SESSION}`);
    expect(parseWorkbenchPath(path)).toEqual({ ...location, tabs: [] });
  });

  it("writes UUID locators as 8-hex tokens without /d/ or /w/ wrappers", () => {
    const path = formatWorkbenchPath({
      deviceHandle: MACHINE,
      workspaceId: PROJECT,
      sessionId: TALK,
      preview: `${ROOT}/genethub/skills/genet-cli/SKILL.md`,
      dialog: null,
    });
    expect(path).toBe(
      `/m-17ef85c5/w-cb37e25b/s-a1b2c3d4?preview=r-c6c2ec07%2Fgenethub%2Fskills%2Fgenet-cli%2FSKILL.md`,
    );
    expect(parseWorkbenchPath(`/m-17ef85c5/w-cb37e25b/s-a1b2c3d4`)).toEqual({
      deviceHandle: "m-17ef85c5",
      workspaceId: "w-cb37e25b",
      sessionId: "s-a1b2c3d4",
      preview: null,
      dialog: null,
      tabs: [],
    });
  });

  it("treats s-new as an unsent draft, not a stored session", () => {
    const path = formatWorkbenchPath({
      deviceHandle: MACHINE,
      workspaceId: PROJECT,
      sessionId: NEW_SESSION_ID,
      preview: null,
      dialog: null,
    });
    expect(path).toBe(`/m-17ef85c5/w-cb37e25b/s-new`);
    expect(parseWorkbenchPath(path)?.sessionId).toBe(NEW_SESSION_ID);
  });

  it("still reads /s/new on a legacy bookmark", () => {
    const path = formatWorkbenchPath({
      deviceHandle: DEVICE,
      workspaceId: WORKSPACE,
      sessionId: NEW_SESSION_ID,
      preview: null,
      dialog: null,
    });
    expect(path).toBe(`/d/${DEVICE}/w/${WORKSPACE}/s/new`);
    expect(parseWorkbenchPath(path)?.sessionId).toBe(NEW_SESSION_ID);
  });

  it("folds ?dialog=new-session into /s/new so the two spellings are one address", () => {
    expect(parseWorkbenchPath(`/d/${DEVICE}/w/${WORKSPACE}`, "?dialog=new-session")).toEqual({
      deviceHandle: DEVICE,
      workspaceId: WORKSPACE,
      sessionId: NEW_SESSION_ID,
      preview: null,
      dialog: null,
      tabs: [],
    });
    expect(
      formatWorkbenchPath({
        deviceHandle: DEVICE,
        workspaceId: WORKSPACE,
        sessionId: NEW_SESSION_ID,
        dialog: "new-session",
        preview: null,
      }),
    ).toBe(`/d/${DEVICE}/w/${WORKSPACE}/s/new`);
  });

  it("keeps overlays in the query so a file and a dialog can sit on a session", () => {
    const location = {
      deviceHandle: DEVICE,
      workspaceId: WORKSPACE,
      sessionId: SESSION,
      preview: "r_a81f0000/docs/readme.md",
      dialog: "feedback" as const,
    };
    const path = formatWorkbenchPath(location);
    expect(path).toContain("preview=r-a81f0000%2Fdocs%2Freadme.md");
    expect(path).toContain("dialog=feedback");
    expect(parseWorkbenchPath(path.split("?")[0]!, `?${path.split("?")[1]}`)).toEqual({
      ...location,
      preview: "r-a81f0000/docs/readme.md",
      tabs: [],
    });
  });

  it("accepts the open-workspace dialog without inventing a session", () => {
    const parsed = parseWorkbenchPath(`/d/${DEVICE}/w/${WORKSPACE}`, "?dialog=open-workspace");
    expect(parsed).toEqual({
      deviceHandle: DEVICE,
      workspaceId: WORKSPACE,
      sessionId: null,
      preview: null,
      dialog: "open-workspace",
      tabs: [],
    });
  });

  it("keeps a tab strip on the query and drops it when the encoded form is too large", () => {
    const small = formatWorkbenchPath({
      deviceHandle: MACHINE,
      workspaceId: PROJECT,
      sessionId: TALK,
      preview: null,
      dialog: null,
      tabs: ["s-a1b2c3d4", "term", "files"],
    });
    expect(small).toContain("tabs=s-a1b2c3d4%2Cterm%2Cfiles");
    expect(parseWorkbenchPath(small.split("?")[0]!, `?${small.split("?")[1]}`)?.tabs).toEqual([
      "s-a1b2c3d4",
      "term",
      "files",
    ]);
    const huge = Array.from(
      { length: 8 },
      (_, index) => `f-c6c2ec07/${"very-long-folder/".repeat(20)}file-${index}.md`,
    );
    expect(encodeTabsQuery(huge)).toBeNull();
  });

  it("still reads a legacy /d/ bookmark that used full UUID handles", () => {
    const parsed = parseWorkbenchPath(`/d/${MACHINE}/w/${PROJECT}/s/${TALK}`);
    expect(parsed).toEqual({
      deviceHandle: MACHINE,
      workspaceId: PROJECT,
      sessionId: TALK,
      preview: null,
      dialog: null,
      tabs: [],
    });
    expect(formatWorkbenchPath(parsed!)).toBe(`/m-17ef85c5/w-cb37e25b/s-a1b2c3d4`);
  });

  it("keeps a machine or workspace home from growing a draft session segment", () => {
    const draft = {
      deviceHandle: MACHINE,
      workspaceId: PROJECT,
      sessionId: NEW_SESSION_ID,
      preview: null,
      dialog: null,
    };
    expect(formatWorkbenchPath(scopedWorkbenchLocation("machine", draft))).toBe("/m-17ef85c5");
    expect(formatWorkbenchPath(scopedWorkbenchLocation("workspace", draft))).toBe(
      "/m-17ef85c5/w-cb37e25b",
    );
    expect(formatWorkbenchPath(scopedWorkbenchLocation("session", { ...draft, sessionId: TALK }))).toBe(
      "/m-17ef85c5/w-cb37e25b/s-a1b2c3d4",
    );
  });

  it("rejects a ticket-shaped query and other non-canonical spellings", () => {
    expect(parseWorkbenchPath("/d/dev/w/ws/s/s1/extra")).toBeNull();
    expect(parseWorkbenchPath("/d/dev/../w/ws")).toBeNull();
    expect(parseWorkbenchPath(`/d/${DEVICE}`, "?preview=../secret")).toBeNull();
    expect(parseWorkbenchPath(`/d/${DEVICE}`, "?preview=/etc/passwd")).toBeNull();
    expect(parseWorkbenchPath("/machines")).toBeNull();
    expect(parseWorkbenchPath("/")).toBeNull();
    expect(parseWorkbenchPath("/m-17ef85c5/extra")).toBeNull();
  });

  it("keeps a Cloud subpath out of the locator and puts it back on the href", () => {
    const location = {
      deviceHandle: DEVICE,
      workspaceId: WORKSPACE,
      sessionId: SESSION,
      preview: null,
      dialog: null,
    };
    expect(
      parseWorkbenchHref(`/console/d/${DEVICE}/w/${WORKSPACE}/s/${SESSION}`, "", "/console/"),
    ).toEqual({ ...location, tabs: [] });
    expect(formatWorkbenchHref(location, "/console/")).toBe(
      `/console/d/${DEVICE}/w/${WORKSPACE}/s/${SESSION}`,
    );
    expect(
      parseWorkbenchHref("/relay-dev-2/m-17ef85c5/w-cb37e25b/s-new", "", "/relay-dev-2/"),
    ).toEqual({
      deviceHandle: "m-17ef85c5",
      workspaceId: "w-cb37e25b",
      sessionId: NEW_SESSION_ID,
      preview: null,
      dialog: null,
      tabs: [],
    });
  });
});

describe("short locators", () => {
  it("shortens a UUID handle and expands it only when the roster is unique", () => {
    expect(shortenLocator(MACHINE)).toBe("m-17ef85c5");
    expect(expandLocator("m-17ef85c5", [MACHINE])).toBe(MACHINE);
    expect(expandLocator("m-17ef85c5", [MACHINE, "m_17ef85c5aaaaaaaaaaaaaaaaaaaaaaaa"])).toBeNull();
    expect(locatorsMatch("m-17ef85c5", MACHINE)).toBe(true);
    expect(locatorsMatch(MACHINE, "m_ffffffffffffffffffffffffffffffff")).toBe(false);
    expect(locatorsMatch(MACHINE, "m_17ef85c5aaaaaaaaaaaaaaaaaaaaaaaa")).toBe(false);
  });
});
