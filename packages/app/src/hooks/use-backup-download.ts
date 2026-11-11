import { useCallback, useMemo } from "react";
import { getHostRuntimeStore, useHosts, useHostRuntimeClient } from "@/runtime/host-runtime";
import { useDownloadStore } from "@/stores/download-store";

/**
 * Saves one of this host's backups to the device through the same download
 * pipelined as workspace files: the daemon issues a single-use token for the
 * file in `$NEOLIX_HOME/backups`, and the download route serves it. A relay,
 * SSH or socket host has no HTTP endpoint, and a backup has no session-socket
 * reader, so saving one needs a direct connection.
 */
export function useBackupDownload(serverId: string | null): (name: string) => void {
  const client = useHostRuntimeClient(serverId ?? "");
  const daemons = useHosts();
  const daemonProfile = useMemo(
    () => daemons.find((daemon) => daemon.serverId === serverId),
    [daemons, serverId],
  );
  const startDownload = useDownloadStore((state) => state.startDownload);

  return useCallback(
    (name: string) => {
      if (!client || serverId === null) {
        return;
      }
      void startDownload({
        serverId,
        scopeId: "backups",
        fileName: name,
        path: name,
        daemonProfile,
        activeConnectionId: getHostRuntimeStore().getSnapshot(serverId)?.activeConnectionId ?? null,
        requestFileDownloadToken: async () => {
          const response = await client.requestBackupDownloadToken(name);
          return {
            token: response.token,
            fileName: response.fileName ?? name,
            mimeType: response.mimeType,
            size: response.size,
            error: response.error,
          };
        },
        readFile: async () => {
          throw new Error("Saving a backup needs a direct connection to the host");
        },
      });
    },
    [client, daemonProfile, serverId, startDownload],
  );
}
