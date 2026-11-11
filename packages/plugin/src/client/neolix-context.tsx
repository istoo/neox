import type { NeolixApi } from "@neolix/client";
import { createContext, useContext, type ReactNode } from "react";

const NeolixApiContext = createContext<NeolixApi | null>(null);

export function useNeolixContextValue(): NeolixApi | null {
  return useContext(NeolixApiContext);
}

export function NeolixApiProvider({
  children,
  neolix,
}: {
  children: ReactNode;
  neolix: NeolixApi;
}) {
  return <NeolixApiContext.Provider value={neolix}>{children}</NeolixApiContext.Provider>;
}

export function useNeolix(): NeolixApi {
  const neolix = useNeolixContextValue();
  if (!neolix) throw new Error("useNeolix must run inside a contributed plugin surface");
  return neolix;
}
