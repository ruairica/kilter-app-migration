const hasFileArg = process.argv[2] && !process.argv[2].startsWith("-");

if (hasFileArg) {
  await import("./cli.js");
} else {
  const { startServer } = await import("./server.js");
  startServer();
}
