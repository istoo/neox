// @types/node 20 has no declarations for node:sqlite; the server runs on a
// Node that has it, so declare only what the external-sessions reader uses.
declare module "node:sqlite" {
  export interface StatementResult {
    changes: number | bigint;
    lastInsertRowid: number | bigint;
  }

  export interface Statement {
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
    run(...params: unknown[]): StatementResult;
  }

  export class DatabaseSync {
    constructor(path: string, options?: { readOnly?: boolean });
    exec(sql: string): void;
    prepare(sql: string): Statement;
    close(): void;
  }
}
