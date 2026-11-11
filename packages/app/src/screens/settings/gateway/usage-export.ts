import { File as FSFile, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import { isWeb } from "@/constants/platform";

/**
 * Hands a CSV to the user: the browser's download manager on web and
 * Electron, the share sheet on native. Mirrors the download store's save.
 */
export async function saveUsageCsv(
  text: string,
  fileName: string,
  noDirectoryMessage = "No download directory available.",
): Promise<void> {
  if (isWeb) {
    const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    // The browser may still be reading the blob while its save prompt is open.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return;
  }
  const directory = Paths.cache ?? Paths.document;
  if (directory === null) {
    throw new Error(noDirectoryMessage);
  }
  const file = new FSFile(directory, fileName);
  if (file.exists) {
    file.delete();
  }
  file.write(text);
  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(file.uri, { mimeType: "text/csv", dialogTitle: fileName });
  }
}
