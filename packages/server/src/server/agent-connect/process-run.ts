import { execFile } from "node:child_process";

/** Runs a host command and answers its stdout. */
export function runProcess(command: string, args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(stdout);
    });
    if (input !== undefined) {
      child.stdin?.end(input);
    }
  });
}
