process.on("message", (message) => {
  if (message?.type !== "neolix_frame") return;
  process.send?.(message);
});
