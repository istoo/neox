import type { LibrarySnapshot, LibrarySyncResult } from "@neolix/protocol/library";
import type { DaemonClient } from "@neolix/client/internal/daemon-client";

export interface LibraryTabProps {
  serverId: string;
  library: LibrarySnapshot;
  client: DaemonClient;
  onLibrary: (library: LibrarySnapshot) => void;
  onSaved: (result: LibrarySyncResult) => void;
  onError: (error: unknown) => void;
  disabled: boolean;
}
