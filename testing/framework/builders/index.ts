import { spawnSync } from "node:child_process";

export const data = {
  tasks: {
    writeFile(relative: string, contents: string) {
      return {
        prompt: `Write exactly ${JSON.stringify(contents)} to ${relative} and stop.`,
        relative,
        contents,
      };
    },
  },
  git: {
    init(root: string): void {
      spawnSync("git", ["init"], { cwd: root, encoding: "utf8" });
      spawnSync("git", ["config", "user.email", "parity@genehub.test"], { cwd: root, encoding: "utf8" });
      spawnSync("git", ["config", "user.name", "parity"], { cwd: root, encoding: "utf8" });
    },
  },
};
