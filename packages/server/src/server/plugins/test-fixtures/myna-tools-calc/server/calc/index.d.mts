export interface MynaCalcTool {
  description: string;
  args: unknown;
  execute(args: Record<string, unknown>): unknown | Promise<unknown>;
}

export declare function CalcTools(input?: unknown): Promise<{ tool: Record<string, MynaCalcTool> }>;
