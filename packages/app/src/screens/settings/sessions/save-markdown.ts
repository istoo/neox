import { isWeb } from "@/constants/platform";

/** Saves a Markdown file the reader asked for: a browser download, or a share. */
export async function saveMarkdownFile(
  fileName: string,
  markdown: string,
  noCacheFolderMessage = "no cache folder to write the file to",
): Promise<void> {
  if (isWeb && typeof document !== "undefined") {
    const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    link.rel = "noopener";
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
    return;
  }
  const FileSystem = await import("expo-file-system/legacy");
  const Sharing = await import("expo-sharing");
  const directory = FileSystem.cacheDirectory;
  if (directory === null) {
    throw new Error(noCacheFolderMessage);
  }
  const uri = `${directory}${fileName}`;
  await FileSystem.writeAsStringAsync(uri, markdown);
  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(uri, { mimeType: "text/markdown", dialogTitle: fileName });
  }
}
